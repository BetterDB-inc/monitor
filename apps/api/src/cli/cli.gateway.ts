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
}
