import { Injectable, Logger } from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { randomUUID } from 'crypto';
import { AgentTokensService } from './agent-tokens.service';
import { AgentDatabaseAdapter } from './agent-database-adapter';
import { ConnectionRegistry } from '../../apps/api/src/connections/connection-registry.service';
import type { AgentHelloMessage, AgentConnectionInfo } from '@betterdb/shared';

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

    const validation = await this.tokenService.validateToken(token);
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
    const connectionId = `agent-${randomUUID().slice(0, 8)}`;
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
      this.unregisterAgent(connectionId);
    });

    ws.on('error', (err) => {
      this.logger.error(`Agent ${connectionId} WebSocket error: ${err.message}`);
    });
  }

  private async registerAgent(agent: AgentConnection): Promise<void> {
    const hello = agent.agentHello!;
    this.logger.log(
      `Agent ${agent.id} hello: ${hello.valkey.type} ${hello.valkey.version} ` +
      `(cluster: ${hello.valkey.cluster}, capabilities: ${hello.capabilities.join(', ')})`,
    );

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
      );
      this.logger.log(`Agent ${agent.id} registered as connection`);
    } catch (err: any) {
      this.logger.error(`Failed to register agent ${agent.id}: ${err.message}`);
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

  private unregisterAgent(connectionId: string): void {
    const agent = this.agents.get(connectionId);
    if (!agent) return;

    if (agent.pingTimer) clearInterval(agent.pingTimer);
    if (agent.pongTimer) clearTimeout(agent.pongTimer);

    if (agent.adapter) {
      agent.adapter.markDisconnected();
    }

    // Remove from ConnectionRegistry
    this.connectionRegistry.removeAgentConnection(connectionId);

    this.agents.delete(connectionId);
    this.logger.log(`Agent ${connectionId} disconnected and unregistered`);
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
        });
      }
    }
    return result;
  }
}
