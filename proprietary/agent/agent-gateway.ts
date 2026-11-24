import { Injectable, Logger } from '@nestjs/common';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { createHash } from 'crypto';
import { AgentTokensService } from './agent-tokens.service';
import { AgentDatabaseAdapter } from './agent-database-adapter';
import { ConnectionRegistry } from '../../apps/api/src/connections/connection-registry.service';
import type { AgentHelloMessage, AgentConnectionInfo, AgentIdentity } from '@betterdb/shared';

const LIVENESS_CHECK_MS = 5000;

/**
 * Identified agents (one process relaying many nodes) may hold at most this
 * many connections per token; beyond it the gateway turns new ones away rather
 * than let one token fill the registry.
 */
export const MAX_CONNECTIONS_PER_TOKEN = 512;

const IDENTITY_PLATFORMS: ReadonlySet<string> = new Set(['openeverest']);
const IDENTITY_MAX_LENGTH = 253;
// DNS-style names for the Kubernetes-side labels; the node key may be a
// cluster node id, host:port or a pod name, the cluster id a UID.
const DNS_NAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const NODE_KEY = /^[A-Za-z0-9][A-Za-z0-9.:_[\]-]*$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function validField(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= IDENTITY_MAX_LENGTH && pattern.test(value);
}

/**
 * Checks an identity from the wire: the platform comes from an allowlist,
 * cluster, namespace, instance and node are required, every field is a
 * bounded string of an expected shape, and nothing else is kept. Returns null
 * for anything malformed, which the gateway rejects.
 */
export function validateIdentity(raw: unknown): AgentIdentity | null {
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.platform !== 'string' || !IDENTITY_PLATFORMS.has(value.platform)) return null;
  if (!validField(value.cluster, DNS_NAME) || !validField(value.namespace, DNS_NAME) || !validField(value.instance, DNS_NAME)) return null;
  if (!validField(value.node, NODE_KEY)) return null;
  if (value.clusterId !== undefined && !validField(value.clusterId, OPAQUE_ID)) return null;
  if (value.nodeName !== undefined && !validField(value.nodeName, OPAQUE_ID)) return null;
  const identity: AgentIdentity = {
    platform: value.platform as AgentIdentity['platform'],
    cluster: value.cluster,
    namespace: value.namespace,
    instance: value.instance,
    node: value.node,
  };
  if (value.clusterId !== undefined) identity.clusterId = value.clusterId;
  if (value.nodeName !== undefined) identity.nodeName = value.nodeName;
  return identity;
}

/**
 * Connection id for an agent. A single-target agent is its token: one token,
 * one database. A multi-target agent (OpenEverest) sends an identity with each
 * node it relays, and the id is derived from that instead, so a node keeps its
 * id (and its history) when the agent pod restarts or fails over.
 *
 * The hash is scoped by the token's name, not its id: ids survive rotating
 * the token (create the new one under the same name), while a token created
 * under another name cannot take over an existing node's id. Tokens carry no
 * owner today, so the name is the stable handle an admin controls. The
 * Kubernetes cluster id is preferred over the OpenEverest cluster name, which
 * is only a label the user picked.
 */
export function agentConnectionId(tokenId: string, tokenName: string, identity?: AgentIdentity): string {
  if (!identity) return `agent-${tokenId}`;
  const cluster = identity.clusterId || identity.cluster;
  const digest = createHash('sha256')
    .update([tokenName, identity.platform, cluster, identity.namespace, identity.instance, identity.node].join('\0'))
    .digest('hex');
  return `agent-${identity.platform}-${digest.slice(0, 16)}`;
}

/** Display name for an identified agent connection: namespace/instance/node. */
export function agentConnectionName(tokenName: string, identity?: AgentIdentity): string {
  if (!identity) return tokenName;
  return `${identity.namespace}/${identity.instance}/${identity.nodeName || identity.node}`;
}

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
  private claims = new Map<string, Promise<void>>();

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
    // The id is provisional until agent_hello: an identified agent gets one
    // derived from its labels (see agentConnectionId).
    let connectionId = `agent-${tokenId}`;
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
          const hello = msg as AgentHelloMessage;
          if (hello.identity !== undefined) {
            const identity = validateIdentity(hello.identity);
            if (!identity) {
              this.logger.warn(`Agent ${connectionId} sent a malformed identity, closing`);
              ws.close(4004, 'Invalid identity');
              return;
            }
            hello.identity = identity;
            if (this.connectionsForToken(tokenId) >= MAX_CONNECTIONS_PER_TOKEN) {
              this.logger.warn(`Agent ${connectionId}: token ${tokenName} already has ${MAX_CONNECTIONS_PER_TOKEN} connections, turning this one away`);
              ws.close(4005, 'Too many connections for this token');
              return;
            }
          }
          agent.agentHello = hello;
          agent.id = agentConnectionId(tokenId, tokenName, hello.identity);
          agent.name = agentConnectionName(tokenName, hello.identity);
          connectionId = agent.id;
          this.queueRegistration(agent);
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

  private connectionsForToken(tokenId: string): number {
    let count = 0;
    for (const agent of this.agents.values()) if (agent.tokenId === tokenId) count++;
    return count;
  }

  private queueRegistration(agent: AgentConnection): void {
    const register = () => this.registerAgent(agent);
    const prior = this.claims.get(agent.id) ?? Promise.resolve();
    const claim = prior.then(register, register);
    this.claims.set(agent.id, claim);
    void claim.finally(() => {
      if (this.claims.get(agent.id) === claim) this.claims.delete(agent.id);
    });
  }

  private async registerAgent(agent: AgentConnection): Promise<void> {
    if (agent.ws.readyState !== WebSocket.OPEN) return;

    const hello = agent.agentHello!;
    this.logger.log(
      `Agent ${agent.id} hello: ${hello.valkey.type} ${hello.valkey.version} ` +
      `(cluster: ${hello.valkey.cluster}, auth: ${hello.authMode ?? 'password'}, ` +
      `capabilities: ${hello.capabilities.join(', ')}` +
      (hello.identity ? `, identity: ${agent.name}` : '') +
      (hello.readOnly ? ', read-only' : '') + ')',
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
        { serverless: hello.valkey.serverless === true, readOnly: hello.readOnly === true },
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

      const answered = await this.answersPing(previous.ws, agent.ws);
      if (agent.ws.readyState !== WebSocket.OPEN) return 'closed';
      if (this.agents.get(agent.id) !== previous) continue;
      if (answered && previous.ws.readyState === WebSocket.OPEN) return 'taken';

      this.retireAgent(previous);
      previous.ws.close(4003, 'Replaced by a new connection');
      previous.ws.terminate();
      this.logger.log(`Agent ${agent.id} reconnected, dropped its previous socket`);
      return 'replaced';
    }
  }

  private answersPing(ws: WebSocket, asker: WebSocket): Promise<boolean> {
    if (ws.readyState !== WebSocket.OPEN) return Promise.resolve(false);

    return new Promise((resolve) => {
      const finish = (answered: boolean) => {
        clearTimeout(timer);
        ws.off('message', onMessage);
        ws.off('close', onClose);
        asker.off('close', onClose);
        resolve(answered);
      };
      const onMessage = (data: RawData) => {
        if (isPong(data)) finish(true);
      };
      const onClose = () => finish(false);
      const timer = setTimeout(() => finish(false), LIVENESS_CHECK_MS);

      ws.on('message', onMessage);
      ws.on('close', onClose);
      asker.on('close', onClose);
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
          identity: agent.agentHello.identity,
          readOnly: agent.agentHello.readOnly,
        });
      }
    }
    return result;
  }
}
