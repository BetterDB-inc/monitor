import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { Actor } from '@betterdb/shared';
import { ActorResolver } from '../auth/actor-resolver';
import { rejectUpgrade } from '../auth/upgrade-response';
import { isReadCommand } from '../cluster/write-commands';
import { ActivityService } from '../activity/activity.service';
import { parseCommandLine } from './command-parser';
import { CliService } from './cli.service';
import { CliExecuteMessage, CliServerMessage } from './cli.types';

const SECRET_COMMANDS = new Set(['AUTH', 'HELLO']);

const MAX_COMMANDS_PER_SECOND = 50;
const SESSION_EXPIRED_CLOSE_CODE = 4401;
const SESSION_EXPIRED_CLOSE_REASON = 'Session expired';
export const SESSION_EXPIRED_MESSAGE = 'Session expired. Sign in again.';

interface CliConnectionState {
  request: IncomingMessage;
  tokens: number;
  lastRefill: number;
}

interface CommandAccess {
  sessionValid: boolean;
  readOnly: boolean;
  actor: Actor | null;
}

@Injectable()
export class CliGateway implements OnModuleDestroy {
  private readonly logger = new Logger(CliGateway.name);
  private readonly wss: WebSocketServer;
  private readonly connections = new Map<WebSocket, CliConnectionState>();

  constructor(
    private readonly cliService: CliService,
    @Optional()
    @Inject(ActorResolver)
    private readonly actorResolver: ActorResolver | null = null,
    @Optional()
    @Inject(ActivityService)
    private readonly activity: ActivityService | null = null,
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
    socket.on('error', () => {
      socket.destroy();
    });
    this.authorizeUpgrade(request, socket, head).catch(() => {
      socket.destroy();
    });
  }

  private isAuthEnabled(): boolean {
    return this.actorResolver !== null && this.actorResolver.isEnabled() === true;
  }

  private async resolveActor(request: IncomingMessage): Promise<Actor | null> {
    if (this.actorResolver === null) {
      return null;
    }
    return this.actorResolver.resolveFromUpgrade(request);
  }

  private async authorizeUpgrade(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> {
    if (this.isAuthEnabled() === true) {
      const actor = await this.resolveActor(request);
      if (actor === null) {
        rejectUpgrade(socket, 401);
        return;
      }
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.attach(ws, request);
    });
  }

  private attach(ws: WebSocket, request: IncomingMessage): void {
    this.logger.log('CLI WebSocket client connected');
    this.connections.set(ws, { request, tokens: MAX_COMMANDS_PER_SECOND, lastRefill: Date.now() });
    this.handleConnection(ws);
  }

  private async resolveAccess(ws: WebSocket): Promise<CommandAccess> {
    const state = this.connections.get(ws);
    if (state === undefined) {
      return { sessionValid: true, readOnly: true, actor: null };
    }
    if (this.isAuthEnabled() === false) {
      return { sessionValid: true, readOnly: false, actor: null };
    }
    const actor = await this.resolveActor(state.request);
    if (actor === null) {
      return { sessionValid: false, readOnly: true, actor: null };
    }
    return { sessionValid: true, readOnly: actor.role === 'member', actor };
  }

  private recordCommand(
    ws: WebSocket,
    actor: Actor | null,
    message: CliExecuteMessage,
    result: CliServerMessage,
  ): void {
    if (this.activity === null || actor === null) {
      return;
    }
    const state = this.connections.get(ws);
    if (state === undefined) {
      return;
    }
    const args = parseCommandLine(message.command.trim());
    if (args.length === 0) {
      return;
    }
    const command = args[0].toUpperCase();
    const rest = args.slice(1);
    const details: Record<string, unknown> = { command, argCount: rest.length };
    if (SECRET_COMMANDS.has(command) === false && isReadCommand(command) === true) {
      details.args = rest;
    }
    void this.activity.record({
      actor: { userId: actor.userId, email: actor.email, via: 'cli', tokenId: actor.tokenId },
      action: 'cli.command',
      statusCode: result.type === 'error' ? 400 : 200,
      ip: state.request.socket.remoteAddress ?? '',
      connectionId: message.connectionId ?? null,
      details,
    });
  }

  private expireSession(ws: WebSocket): void {
    const errorMsg: CliServerMessage = { type: 'error', error: SESSION_EXPIRED_MESSAGE };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(errorMsg));
    }
    ws.close(SESSION_EXPIRED_CLOSE_CODE, SESSION_EXPIRED_CLOSE_REASON);
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
          const access = await this.resolveAccess(ws);
          if (access.sessionValid === false) {
            this.expireSession(ws);
            return;
          }
          const result = await this.cliService.execute(message.command, message.connectionId, {
            readOnly: access.readOnly,
          });
          this.recordCommand(ws, access.actor, message, result);
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
    if (state === undefined) {
      return false;
    }

    const now = Date.now();
    const elapsed = (now - state.lastRefill) / 1000;
    state.tokens = Math.min(
      MAX_COMMANDS_PER_SECOND,
      state.tokens + elapsed * MAX_COMMANDS_PER_SECOND,
    );
    state.lastRefill = now;

    if (state.tokens < 1) {
      return false;
    }
    state.tokens -= 1;
    return true;
  }
}
