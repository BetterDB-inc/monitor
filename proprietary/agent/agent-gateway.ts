import { Injectable, Logger } from '@nestjs/common';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { AgentTokensService } from './agent-tokens.service';
import { AgentDatabaseAdapter } from './agent-database-adapter';
import { ConnectionRegistry } from '../../apps/api/src/connections/connection-registry.service';
import type { AgentHelloMessage, AgentConnectionInfo } from '@betterdb/shared';

const LIVENESS_CHECK_MS = 5000;

type ConnectionIdClaim = 'free' | 'replaced' | 'taken' | 'closed';

function isPong(data: RawData): boolean {
  try {
    return JSON.parse(data.toString()).type === 'pong';
  } catch {
    return false;
  }
}

interface AgentConnection {
  id: string;
  tokenId: string;
  name: string;
  ws: WebSocket;
  adapter: AgentDatabaseAdapter;
  connectedAt: number;
  agentHello: AgentHelloMessage | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  pongTimer: ReturnType<typeof setTimeout> | null;
}

@Injectable()
export class AgentGateway {
  private readonly logger = new Logger(AgentGateway.name);
  private wss: WebSocketServer;
  private agents = new Map<string, AgentConnection>();

  constructor(
    private readonly tokenService: AgentTokensService,
    private readonly connectionRegistry: ConnectionRegistry,
  ) {
    this.wss = new WebSocketServer({ noServer: true });
  }

  async handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const authHeader = request.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : new URL(request.url || '', `http://${request.headers.host}`).searchParams.get('token');

    if (!token) {
      this.logger.warn('Agent connection rejected: no token');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const validation = await this.tokenService.validateToken(token, 'agent');
    if (!validation.valid) {
      this.logger.warn('Agent connection rejected: invalid token');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.onConnection(ws, validation.tokenId!, validation.name!);
    });
  }

  private onConnection(ws: WebSocket, tokenId: string, tokenName: string): void {
    const connectionId = `agent-${tokenId}`;
    this.logger.log(`Agent connected: ${connectionId} (token: ${tokenName})`);

    const agent: AgentConnection = {
      id: connectionId,
      tokenId,
      name: tokenName,
      ws,
      adapter: null as any, // Will be set after hello
      connectedAt: Date.now(),
      agentHello: null,
      pingTimer: null,
      pongTimer: null,
    };

    // Wait for agent_hello
    const helloTimeout = setTimeout(() => {
      this.logger.warn(`Agent ${connectionId} did not send hello in time`);
      ws.close(4001, 'Hello timeout');
    }, 10000);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'agent_hello' && !agent.agentHello) {
          clearTimeout(helloTimeout);
          agent.agentHello = msg as AgentHelloMessage;
          this.registerAgent(agent);
          return;
        }

        if (msg.type === 'pong') {
          if (agent.pongTimer) {
            clearTimeout(agent.pongTimer);
            agent.pongTimer = null;
          }
          return;
        }

        if (msg.type === 'ping') {
          agent.ws?.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
          return;
        }

        // response/error messages are handled by the adapter's own message listener
      } catch (err: any) {
        this.logger.error(`Error processing agent message: ${err.message}`);
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimeout);
      this.unregisterAgent(connectionId, ws);
    });

    ws.on('error', (err) => {
      this.logger.error(`Agent ${connectionId} WebSocket error: ${err.message}`);
    });
  }

  private async registerAgent(agent: AgentConnection): Promise<void> {
    const hello = agent.agentHello!;
    this.logger.log(
      `Agent ${agent.id} hello: ${hello.valkey.type} ${hello.valkey.version} ` +
      `(cluster: ${hello.valkey.cluster}, auth: ${hello.authMode ?? 'password'}, ` +
      `capabilities: ${hello.capabilities.join(', ')})`,
    );

    const claim = await this.claimConnectionId(agent);
    if (claim === 'closed') return;
    if (claim === 'taken') {
      this.logger.warn(`Agent ${agent.id}: another agent is already connected with this token, turning the new one away`);
      agent.ws.close(4003, 'Another agent is connected with this token');
      return;
    }

    // Create the DatabaseAdapter
    agent.adapter = new AgentDatabaseAdapter(agent.ws, hello);

    // Register with ConnectionRegistry by directly setting into the internal maps
    // We use the same approach as addConnection but skip the storage persistence
    // since agent connections are transient
    try {
      await this.connectionRegistry.registerAgentConnection(
        agent.id,
        agent.name,
        agent.adapter,
        { serverless: hello.valkey.serverless === true },
      );
      this.logger.log(`Agent ${agent.id} registered as connection`);
    } catch (err: any) {
      this.logger.error(`Failed to register agent ${agent.id}: ${err.message}`);
      if (claim === 'replaced') this.connectionRegistry.removeAgentConnection(agent.id);
      agent.ws.close(4002, 'Registration failed');
      return;
    }

    this.agents.set(agent.id, agent);

    // Start heartbeat
    agent.pingTimer = setInterval(() => {
      if (agent.ws.readyState === WebSocket.OPEN) {
        agent.ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        agent.pongTimer = setTimeout(() => {
          this.logger.warn(`Agent ${agent.id} pong timeout`);
          agent.ws.close(4000, 'Pong timeout');
        }, 10000);
      }
    }, 30000);
  }

  private async claimConnectionId(agent: AgentConnection): Promise<ConnectionIdClaim> {
    for (;;) {
      const previous = this.agents.get(agent.id);
      if (!previous) return 'free';

      const answered = await this.answersPing(previous.ws);
      if (agent.ws.readyState !== WebSocket.OPEN) return 'closed';
      if (this.agents.get(agent.id) !== previous) continue;
      if (answered) return 'taken';

      this.retireAgent(previous);
      previous.ws.close(4003, 'Replaced by a new connection');
      previous.ws.terminate();
      this.logger.log(`Agent ${agent.id} reconnected, dropped its previous socket`);
      return 'replaced';
    }
  }

  private answersPing(ws: WebSocket): Promise<boolean> {
    if (ws.readyState !== WebSocket.OPEN) return Promise.resolve(false);

    return new Promise((resolve) => {
      const finish = (answered: boolean) => {
        clearTimeout(timer);
        ws.off('message', onMessage);
        ws.off('close', onClose);
        resolve(answered);
      };
      const onMessage = (data: RawData) => {
        if (isPong(data)) finish(true);
      };
      const onClose = () => finish(false);
      const timer = setTimeout(() => finish(false), LIVENESS_CHECK_MS);

      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    });
  }

  private unregisterAgent(connectionId: string, ws: WebSocket): void {
    const agent = this.agents.get(connectionId);
    if (!agent || agent.ws !== ws) return;

    this.retireAgent(agent);

    // Remove from ConnectionRegistry
    this.connectionRegistry.removeAgentConnection(connectionId);

    this.logger.log(`Agent ${connectionId} disconnected and unregistered`);
  }

  private retireAgent(agent: AgentConnection): void {
    if (agent.pingTimer) clearInterval(agent.pingTimer);
    if (agent.pongTimer) clearTimeout(agent.pongTimer);
    agent.pingTimer = null;
    agent.pongTimer = null;

    if (agent.adapter) {
      agent.adapter.markDisconnected();
    }

    if (this.agents.get(agent.id) === agent) {
      this.agents.delete(agent.id);
    }
  }

  getConnectedAgents(): AgentConnectionInfo[] {
    const result: AgentConnectionInfo[] = [];
    for (const [, agent] of this.agents) {
      if (agent.agentHello) {
        result.push({
          id: agent.id,
          tokenId: agent.tokenId,
          name: agent.name,
          connectedAt: agent.connectedAt,
          agentVersion: agent.agentHello.version,
          valkey: agent.agentHello.valkey,
          authMode: agent.agentHello.authMode,
        });
      }
    }
    return result;
  }
}
