import { performance } from 'node:perf_hooks';
import { CONNECT_TIMEOUT_MS, type NodeSpec, PROBE_TIMEOUT_MS, TICK_MS } from './config';
import { type Reply, RespClient } from './resp';

export interface ClusterInfoFields {
  state: string;
  slotsOk: number;
  slotsPfail: number;
  slotsFail: number;
  knownNodes: number;
  size: number;
  currentEpoch: number;
}

export type Sample =
  | { ok: true; lat: number; nodes: string; info: ClusterInfoFields; migrations: Reply }
  | { ok: false; lat: number; err: string };

export interface Tick {
  t: number;
  late: number;
  nodes: Record<string, Sample>;
}

function infoFields(raw: string): ClusterInfoFields {
  const field = (name: string) => raw.match(new RegExp(`${name}:(\\S+)`))?.[1] ?? '';
  return {
    state: field('cluster_state'),
    slotsOk: Number(field('cluster_slots_ok')),
    slotsPfail: Number(field('cluster_slots_pfail')),
    slotsFail: Number(field('cluster_slots_fail')),
    knownNodes: Number(field('cluster_known_nodes')),
    size: Number(field('cluster_size')),
    currentEpoch: Number(field('cluster_current_epoch')),
  };
}

class Probe {
  private client: RespClient | null = null;
  private connecting: Promise<RespClient> | null = null;

  constructor(private readonly node: NodeSpec) {}

  private connection(): Promise<RespClient> {
    if (this.client && !this.client.closed) return Promise.resolve(this.client);
    this.connecting ??= RespClient.connect('127.0.0.1', this.node.hostPort, CONNECT_TIMEOUT_MS)
      .then((client) => {
        this.client = client;
        return client;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  async sample(): Promise<Sample> {
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    let deadline: NodeJS.Timeout | undefined;
    let used: RespClient | null = null;
    try {
      const client = await this.connection();
      used = client;
      deadline = setTimeout(() => client.close(new Error('timeout')), PROBE_TIMEOUT_MS - elapsed());
      const [nodes, info, migrations] = await Promise.all([
        client.send('CLUSTER', 'NODES'),
        client.send('CLUSTER', 'INFO'),
        client.send('CLUSTER', 'GETSLOTMIGRATIONS').catch((err: Error) => `ERR ${err.message}`),
      ]);
      return { ok: true, lat: elapsed(), nodes: String(nodes), info: infoFields(String(info)), migrations };
    } catch (err) {
      used?.close();
      if (this.client === used) this.client = null;
      return { ok: false, lat: elapsed(), err: (err as Error).message.slice(0, 80) };
    } finally {
      clearTimeout(deadline);
    }
  }

  close(): void {
    this.client?.close();
  }
}

export class Recorder {
  readonly ticks: Tick[] = [];
  private readonly probes = new Map<string, Probe>();
  private readonly outstanding = new Set<Promise<void>>();
  private startedAt = 0;
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(nodes: NodeSpec[]) {
    for (const node of nodes) this.addNode(node);
  }

  addNode(node: NodeSpec): void {
    this.probes.set(node.name, new Probe(node));
  }

  now(): number {
    return Math.round(performance.now() - this.startedAt);
  }

  start(): void {
    this.startedAt = performance.now();
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
    await Promise.all(this.outstanding);
    for (const probe of this.probes.values()) probe.close();
  }

  private async run(): Promise<void> {
    for (let index = 0; this.running; index++) {
      const due = index * TICK_MS;
      const wait = due - this.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (!this.running) break;
      const tick: Tick = { t: due, late: this.now() - due, nodes: {} };
      this.ticks.push(tick);
      for (const [name, probe] of this.probes) {
        const pending = probe.sample().then((sample) => {
          tick.nodes[name] = sample;
        });
        this.outstanding.add(pending);
        void pending.finally(() => this.outstanding.delete(pending));
      }
    }
  }
}
