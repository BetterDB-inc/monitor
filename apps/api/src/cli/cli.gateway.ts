import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { CliService } from './cli.service';
import { CliExecuteMessage, CliServerMessage } from './cli.types';

const MAX_COMMANDS_PER_SECOND = 50;

@Injectable()
export class CliGateway implements OnModuleDestroy {
  private readonly logger = new Logger(CliGateway.name);
  private readonly wss: WebSocketServer;
  private readonly clientConnections = new Map<WebSocket, string>();
  private readonly rateLimiters = new Map<WebSocket, { tokens: number; lastRefill: number }>();

  constructor(private readonly cliService: CliService) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 }); // 1 MiB
    this.logger.log('CLI WebSocket gateway initialized');
  }

  onModuleDestroy(): void {
    for (const client of this.wss.clients) {
      client.close(1001, 'Server shutting down');
    }
    this.wss.close();
  }

  handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    // In cloud mode, validate session cookie before accepting the WebSocket connection
    if (process.env.CLOUD_MODE) {
      const sessionSecret = process.env.SESSION_SECRET;
      const tenantSchema = process.env.DB_SCHEMA;
      if (sessionSecret && tenantSchema) {
        const cookie = this.getCookie(request, 'betterdb_session');
        if (!cookie || !this.validateSession(cookie, sessionSecret, tenantSchema)) {
          this.logger.warn('CLI WebSocket upgrade rejected: invalid or missing session');
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      }
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.logger.log('CLI WebSocket client connected');
      this.rateLimiters.set(ws, { tokens: MAX_COMMANDS_PER_SECOND, lastRefill: Date.now() });
      this.handleConnection(ws);
    });
  }

  private handleConnection(ws: WebSocket): void {
    // Serialize command execution per client to guarantee FIFO response order
    let execChain = Promise.resolve();

    ws.on('message', (data: Buffer | string) => {
      // Rate limiting: token bucket
      if (!this.consumeToken(ws)) {
        const errorMsg: CliServerMessage = {
          type: 'error',
          error: 'Rate limit exceeded. Max 50 commands per second.',
        };
        ws.send(JSON.stringify(errorMsg));
        return;
      }

      let message: CliExecuteMessage;
      try {
        const raw = typeof data === 'string' ? data : data.toString('utf-8');
        message = JSON.parse(raw) as CliExecuteMessage;
      } catch {
        const errorMsg: CliServerMessage = { type: 'error', error: 'Invalid JSON message' };
        ws.send(JSON.stringify(errorMsg));
        return;
      }

      if (message.type !== 'execute' || typeof message.command !== 'string') {
        const errorMsg: CliServerMessage = {
          type: 'error',
          error: 'Invalid message format. Expected { type: "execute", command: "..." }',
        };
        ws.send(JSON.stringify(errorMsg));
        return;
      }

      // Track which connectionId this WS client uses (for ref-counting on disconnect)
      if (message.connectionId && !this.clientConnections.has(ws)) {
        this.clientConnections.set(ws, message.connectionId);
        this.cliService.addClientRef(message.connectionId);
      }

      execChain = execChain.then(async () => {
        const result = await this.cliService.execute(message.command, message.connectionId);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(result));
        }
      }).catch(() => {
        // Ensure chain never rejects — errors are handled inside execute()
      });
    });

    ws.on('close', () => {
      const connectionId = this.clientConnections.get(ws);
      if (connectionId) {
        this.cliService.releaseClientRef(connectionId);
        this.clientConnections.delete(ws);
      }
      this.rateLimiters.delete(ws);
      this.logger.log('CLI WebSocket client disconnected');
    });

    ws.on('error', (err: Error) => {
      this.logger.error(`CLI WebSocket error: ${err.message}`);
    });
  }

  private consumeToken(ws: WebSocket): boolean {
    const bucket = this.rateLimiters.get(ws);
    if (!bucket) return false;

    const now = Date.now();
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(MAX_COMMANDS_PER_SECOND, bucket.tokens + elapsed * MAX_COMMANDS_PER_SECOND);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private getCookie(request: IncomingMessage, name: string): string | undefined {
    const cookies = request.headers.cookie || '';
    const match = cookies.split(';').find((c) => c.trim().startsWith(`${name}=`));
    const eqIdx = match?.indexOf('=');
    if (!match || eqIdx === undefined || eqIdx === -1) return undefined;
    return match.slice(eqIdx + 1).trim();
  }

  private validateSession(token: string, secret: string, tenantSchema: string): boolean {
    try {
      // Dynamic import avoided — jwt is only needed in cloud mode
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const jwt = require('jsonwebtoken');
      const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
      const expectedSchema = `tenant_${payload.subdomain.replace(/-/g, '_')}`;
      return expectedSchema === tenantSchema;
    } catch {
      return false;
    }
  }
}
