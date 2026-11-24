import Valkey from 'iovalkey';
import { promises as dns } from 'dns';
import type { AgentIdentity } from '@betterdb/shared';
import { Agent } from '../agent';
import { Informer, KubeClient, KubeObject, sleep } from './kube-client';
import { parseConnectionSecret, ConnectionCredentials, SecretLike } from './connection-secret';
import { discoverNodes, DiscoveredNode } from './cluster-discovery';
import type { InstanceRef } from './everest-client';

// One opted-in OpenEverest instance: watches its connection Secret, discovers
// the Valkey nodes behind it and runs one Agent (one WebSocket to BetterDB)
// per node. Re-reading the Secret on change covers password rotation; the
// periodic rediscovery covers scaling and failover.

export type TargetState = 'off' | 'connecting' | 'monitoring' | 'error';

export interface NodeStatus {
  id: string;
  name: string;
  address: string;
  role: 'primary' | 'replica';
  valkeyConnected: boolean;
  cloudConnected: boolean;
}

export interface TargetStatus {
  state: TargetState;
  error?: string;
  secretName: string | null;
  tls: boolean;
  nodes: NodeStatus[];
}

export interface CloudSettings {
  url: string;
  token: string;
}

export interface InstanceTargetOptions {
  ref: InstanceRef;
  kube: KubeClient;
  /** Current BetterDB settings, or null while none are configured. */
  settings: () => CloudSettings | null;
  clusterId?: string;
  cloudCa?: string;
  rediscoverIntervalMs: number;
  log: (message: string) => void;
}

type Secret = KubeObject & SecretLike;

interface NodeRun {
  node: DiscoveredNode;
  name: string;
  agent: Agent | null;
  error?: string;
}

const RETRY_MS = 15_000;
const CONNECT_TIMEOUT_MS = 5_000;

export class InstanceTarget {
  private secretName: string | null = null;
  private informer: Informer<Secret> | null = null;
  private credentials: ConnectionCredentials | null = null;
  private credentialsKey = '';
  private nodes = new Map<string, NodeRun>();
  // Generation the running agents were started under; see reconcile().
  private nodesGeneration = -1;
  private state: TargetState = 'off';
  private error: string | undefined;
  private stopped = false;
  private generation = 0;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly options: InstanceTargetOptions) {}

  get ref(): InstanceRef {
    return this.options.ref;
  }

  private get tag(): string {
    const { namespace, instance } = this.options.ref;
    return `[${namespace}/${instance}]`;
  }

  /**
   * Point the target at the Secret named by Instance.status.connectionSecretRef.
   * Null (the instance is not ready, or was deleted) tears the connections down.
   */
  setConnectionSecret(name: string | null): void {
    if (this.stopped || name === this.secretName) return;
    this.secretName = name;
    void this.informer?.stop();
    this.informer = null;
    this.setCredentials(null);
    if (!name) {
      this.setState('connecting', 'waiting for the instance to publish connection details');
      return;
    }
    const { namespace } = this.options.ref;
    this.setState('connecting');
    this.informer = new Informer<Secret>({
      client: this.options.kube,
      path: `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`,
      query: `fieldSelector=metadata.name%3D${encodeURIComponent(name)}`,
      onChange: (_key, secret) => this.onSecret(secret),
      log: (m) => this.options.log(`${this.tag} ${m}`),
    });
    this.informer.start();
  }

  /** The BetterDB URL or token changed: every node reconnects with the new ones. */
  onSettingsChanged(): void {
    if (this.stopped) return;
    this.generation += 1;
    this.kick();
  }

  status(): TargetStatus {
    const nodes = Array.from(this.nodes.values()).map((run) => {
      const live = run.agent?.getStatus();
      return {
        id: run.node.id,
        name: run.name,
        address: `${run.node.host}:${run.node.port}`,
        role: run.node.role,
        valkeyConnected: live?.valkeyConnected ?? false,
        cloudConnected: live?.cloudConnected ?? false,
      };
    });
    return { state: this.state, error: this.error, secretName: this.secretName, tls: this.credentials?.tls !== null && this.credentials !== null, nodes };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.informer?.stop();
    this.informer = null;
    this.kick();
    await this.loop;
    await this.stopNodes(Array.from(this.nodes.keys()));
    this.setState('off');
  }

  private onSecret(secret: Secret | null): void {
    if (!secret) {
      this.setCredentials(null);
      this.setState('connecting', 'the connection secret is gone');
      return;
    }
    try {
      this.setCredentials(parseConnectionSecret(secret));
    } catch (err) {
      this.setCredentials(null);
      this.setState('error', (err as Error).message);
    }
  }

  private setCredentials(credentials: ConnectionCredentials | null): void {
    const key = credentials ? JSON.stringify(credentials) : '';
    if (key === this.credentialsKey) return;
    this.credentialsKey = key;
    this.credentials = credentials;
    // A new password or certificate invalidates every open connection.
    this.generation += 1;
    this.kick();
  }

  private setState(state: TargetState, error?: string): void {
    if (state !== this.state || error !== this.error) {
      this.options.log(`${this.tag} ${state}${error ? `: ${error}` : ''}`);
    }
    this.state = state;
    this.error = error;
  }

  // The reconcile loop runs once per wake-up and then every rediscovery
  // interval. Credential changes, settings changes and stop() wake it.
  private kick(): void {
    if (this.wake) {
      this.wake();
    } else if (!this.loop && !this.stopped) {
      this.loop = this.run();
    }
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const generation = this.generation;
      try {
        await this.reconcile(generation);
      } catch (err) {
        this.setState('error', (err as Error).message);
      }
      const delay = this.state === 'monitoring' ? this.options.rediscoverIntervalMs : RETRY_MS;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        setTimeout(resolve, delay);
      }).finally(() => { this.wake = null; });
    }
  }

  private async reconcile(generation: number): Promise<void> {
    const settings = this.options.settings();
    const credentials = this.credentials;
    if (!credentials) {
      await this.stopNodes(Array.from(this.nodes.keys()));
      return;
    }
    if (!settings) {
      await this.stopNodes(Array.from(this.nodes.keys()));
      this.setState('error', 'BetterDB is not configured: set the URL and agent token in Settings');
      return;
    }
    if (generation !== this.generation) return;

    // Anything started under an older generation runs with stale credentials.
    if (this.nodes.size > 0 && this.nodesGeneration !== generation) {
      await this.stopNodes(Array.from(this.nodes.keys()));
    }
    this.nodesGeneration = generation;

    const discovered = await this.discover(credentials);
    if (generation !== this.generation || this.stopped) return;

    const wanted = new Map(discovered.map((n) => [n.id, n]));
    const gone = Array.from(this.nodes.keys()).filter((id) => !wanted.has(id));
    await this.stopNodes(gone);
    for (const node of discovered) {
      const existing = this.nodes.get(node.id);
      if (existing && existing.agent && sameAddress(existing.node, node)) continue;
      if (existing) await this.stopNodes([node.id]);
      await this.startNode(node, credentials, settings);
      if (generation !== this.generation || this.stopped) return;
    }

    const failed = Array.from(this.nodes.values()).filter((run) => run.error);
    if (failed.length === this.nodes.size) {
      this.setState('error', failed[0]?.error ?? 'no node could be reached');
    } else if (failed.length > 0) {
      this.setState('monitoring', `${failed.length} of ${this.nodes.size} nodes unreachable: ${failed[0].error}`);
    } else {
      this.setState('monitoring');
    }
  }

  private async discover(credentials: ConnectionCredentials): Promise<DiscoveredNode[]> {
    const client = new Valkey({
      host: credentials.host,
      port: credentials.port,
      username: credentials.username,
      password: credentials.password,
      tls: tlsOptions(credentials),
      lazyConnect: true,
      connectTimeout: CONNECT_TIMEOUT_MS,
      connectionName: 'BetterDB-Agent-Discovery',
      retryStrategy: () => null,
      maxRetriesPerRequest: 1,
    });
    client.on('error', () => { /* surfaced by connect()/call() */ });
    try {
      await client.connect();
      const nodes = await discoverNodes(client, credentials);
      return Promise.all(nodes.map(async (node) => ({ ...node, hostname: node.hostname || await reverseName(node.host) })));
    } finally {
      client.disconnect();
    }
  }

  private async startNode(node: DiscoveredNode, credentials: ConnectionCredentials, settings: CloudSettings): Promise<void> {
    const name = node.hostname ? node.hostname.split('.')[0] : `${node.host}:${node.port}`;
    const identity: AgentIdentity = {
      platform: 'openeverest',
      clusterId: this.options.clusterId,
      cluster: this.options.ref.cluster,
      namespace: this.options.ref.namespace,
      instance: this.options.ref.instance,
      node: node.id,
      nodeName: name,
    };
    const run: NodeRun = { node, name, agent: null };
    this.nodes.set(node.id, run);
    const agent = new Agent({
      token: settings.token,
      cloudUrl: settings.url,
      valkeyHost: node.host,
      valkeyPort: node.port,
      valkeyUsername: credentials.username,
      valkeyPassword: credentials.password,
      valkeyTls: credentials.tls !== null,
      valkeyTlsOptions: credentials.tls ? { ...credentials.tls, verifyHostname: false } : undefined,
      valkeyDb: 0,
      unsafeMode: false,
      authMode: 'password',
      identity,
      readOnly: true,
      cloudCa: this.options.cloudCa,
      logPrefix: `${this.tag.slice(0, -1)}/${name}]`,
    });
    try {
      await agent.start();
      run.agent = agent;
    } catch (err) {
      // The agent is single-use after a failed start; the next reconcile builds a new one.
      run.error = `${name}: ${(err as Error).message}`;
      await agent.stop().catch(() => undefined);
    }
  }

  private async stopNodes(ids: string[]): Promise<void> {
    await Promise.all(ids.map(async (id) => {
      const run = this.nodes.get(id);
      this.nodes.delete(id);
      await run?.agent?.stop().catch(() => undefined);
    }));
  }
}

function sameAddress(a: DiscoveredNode, b: DiscoveredNode): boolean {
  return a.host === b.host && a.port === b.port;
}

function tlsOptions(credentials: ConnectionCredentials): Record<string, unknown> | undefined {
  if (!credentials.tls) return undefined;
  const { ca, cert, key } = credentials.tls;
  // Chain-only verification, see AgentConfig.valkeyTlsOptions.
  return { ca, cert, key, checkServerIdentity: () => undefined };
}

/**
 * Pod name for a node dialled by IP: StatefulSet pods behind a headless
 * Service resolve back to `<pod>.<service>.<ns>.svc.cluster.local`.
 */
async function reverseName(ip: string): Promise<string | undefined> {
  if (!/^[\d.]+$|:/.test(ip)) return undefined;
  try {
    const names = await Promise.race([dns.reverse(ip), sleep(2_000).then(() => [] as string[])]);
    return names[0] || undefined;
  } catch {
    return undefined;
  }
}
