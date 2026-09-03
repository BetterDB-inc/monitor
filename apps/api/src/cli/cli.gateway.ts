import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { Actor } from '@betterdb/shared';
import { ActorResolver } from '../auth/actor-resolver';
import { rejectUpgrade } from '../auth/upgrade-response';
import { CliService } from './cli.service';
import { CliExecuteMessage, CliServerMessage } from './cli.types';

const MAX_COMMANDS_PER_SECOND = 50;

interface CliConnectionState {
  actor: Actor | null;
  tokens: number;
  lastRefill: number;
}

@Injectable()
export class CliGateway implements OnModuleDestroy {
  private readonly logger = new Logger(CliGateway.name);
  private readonly wss: WebSocketServer;
  private readonly connections = new Map<WebSocket, CliConnectionState>();

  constructor(
    private readonly cliService: CliService,
    private readonly actorResolver: ActorResolver,
  ) {
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
    void this.authorizeUpgrade(request, socket, head);
  }

  private async authorizeUpgrade(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> {
    let actor: Actor | null = null;
    if (this.actorResolver.isEnabled() === true) {
      actor = await this.resolveActor(request);
      if (actor === null) {
        rejectUpgrade(socket, 401);
        return;
      }
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.attach(ws, actor);
    });
  }

  private async resolveActor(request: IncomingMessage): Promise<Actor | null> {
    if (this.actorResolver.isReady() === false) {
      return null;
    }
    try {
      return await this.actorResolver.resolveFromHeaders(
        request.headers,
        request.socket.remoteAddress ?? '',
      );
    } catch {
      return null;
    }
  }

  private attach(ws: WebSocket, actor: Actor | null): void {
    this.logger.log('CLI WebSocket client connected');
    this.connections.set(ws, { actor, tokens: MAX_COMMANDS_PER_SECOND, lastRefill: Date.now() });
    this.handleConnection(ws);
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

      execChain = execChain
        .then(async () => {
          const state = this.connections.get(ws);
          const readOnly =
            state !== undefined && state.actor !== null && state.actor.role === 'member';
          const result = await this.cliService.execute(message.command, message.connectionId, {
            readOnly,
          });
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(result));
          }
        })
        .catch(() => {
          // Ensure chain never rejects — errors are handled inside execute()
        });
    });

    ws.on('close', () => {
      this.connections.delete(ws);
      this.logger.log('CLI WebSocket client disconnected');
    });

    ws.on('error', (err: Error) => {
      this.logger.error(`CLI WebSocket error: ${err.message}`);
    });
  }

  private consumeToken(ws: WebSocket): boolean {
    const state = this.connections.get(ws);
    if (!state) return false;

    const now = Date.now();
    const elapsed = (now - state.lastRefill) / 1000;
    state.tokens = Math.min(
      MAX_COMMANDS_PER_SECOND,
      state.tokens + elapsed * MAX_COMMANDS_PER_SECOND,
    );
    state.lastRefill = now;

    if (state.tokens < 1) return false;
    state.tokens -= 1;
    return true;
  }
}
