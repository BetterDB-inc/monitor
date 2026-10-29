import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CacheSimulatorGrowth, CacheSimulatorInstant, CacheSimulatorSnapshot } from '@betterdb/shared';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { parseKeyspaceDatabases } from '@app/database/parsers/keyspace-databases';
import { collectionPlan } from '../key-analytics/key-analytics-plan';
import { clusterNodes, primaryNodes, type ScanNode } from './cluster-nodes';
import { readInstantStats, type InstantStats } from './instant-stats';
import { readGrowth, sumGrowth } from './growth-fit';
import { estimate, keyMemoryCeiling } from './size-estimator';
import { sampleNodes, SAMPLE_BUDGET, SAMPLE_DEADLINE_MS, SAMPLE_HARD_CAP, type SamplerNode } from './stratified-sampler';

export const RESULT_TTL_MS = 15 * 60_000;
export const FAILURE_TTL_MS = 60_000;
export const SETUP_TIMEOUT_MS = 30_000;
const LABEL = 'Cache simulator';

interface Job {
  instant: CacheSimulatorInstant;
  growth: CacheSimulatorGrowth | null;
  progress: { sampled: number; target: number };
}

@Injectable()
export class CacheSimulatorService {
  private readonly logger = new Logger(CacheSimulatorService.name);
  private readonly jobs = new Map<string, Job>();
  private readonly starting = new Map<string, Promise<CacheSimulatorSnapshot>>();
  private readonly results = new Map<string, { snapshot: CacheSimulatorSnapshot; expiresAt: number }>();

  constructor(
    private readonly registry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
  ) {}

  async snapshot(connectionId: string, refresh = false): Promise<CacheSimulatorSnapshot> {
    this.prune();
    const client = this.registry.get(connectionId);
    const running = this.jobs.get(connectionId);
    if (running) return this.inProgress(running);
    const starting = this.starting.get(connectionId);
    if (starting) return starting;
    const cached = this.results.get(connectionId);
    if (cached && !refresh && Date.now() < cached.expiresAt) return cached.snapshot;
    const name = this.registry.getConfig(connectionId)?.name ?? connectionId;
    const promise = this.start(connectionId, { id: connectionId, name, client }).finally(() => {
      this.starting.delete(connectionId);
    });
    this.starting.set(connectionId, promise);
    return promise;
  }

  private async start(connectionId: string, seed: ScanNode): Promise<CacheSimulatorSnapshot> {
    try {
      const { job, nodes } = await withTimeout(this.prepare(connectionId, seed), SETUP_TIMEOUT_MS, `Setup timed out after ${SETUP_TIMEOUT_MS / 1000} s`);
      this.jobs.set(connectionId, job);
      void this.run(connectionId, job, nodes);
      return this.inProgress(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${LABEL} setup failed for ${connectionId}: ${message}`);
      return this.settle(connectionId, {
        status: 'failed',
        progress: null,
        instant: { usedMemory: 0, maxmemory: 0, maxmemoryPolicy: 'unknown', totalKeys: 0 },
        estimate: null,
        growth: null,
        error: message,
      });
    }
  }

  private async prepare(connectionId: string, seed: ScanNode): Promise<{ job: Job; nodes: SamplerNode[] }> {
    const scanNodes = await this.nodesFor(connectionId, seed);
    const [readings, growth] = await Promise.all([Promise.all(scanNodes.map((node) => this.read(node))), this.growth(scanNodes)]);
    const nodes = readings.map(({ node, stats, keys, otherDbKeys }) => ({
      name: node.name,
      client: node.client,
      ceiling: stats.datasetMemory === null ? undefined : keyMemoryCeiling(stats.datasetMemory, keys),
      otherDbKeys,
    }));
    return { job: { instant: summarize(readings), growth, progress: { sampled: 0, target: SAMPLE_BUDGET } }, nodes };
  }

  private settle(connectionId: string, snapshot: CacheSimulatorSnapshot): CacheSimulatorSnapshot {
    if (this.registry.getConfig(connectionId) === null) return snapshot;
    const cached = this.results.get(connectionId);
    if (snapshot.status === 'failed' && cached?.snapshot.status === 'ready') {
      const kept = { ...cached.snapshot, error: snapshot.error };
      this.results.set(connectionId, { snapshot: kept, expiresAt: Math.max(cached.expiresAt, Date.now() + FAILURE_TTL_MS) });
      return kept;
    }
    const ttl = snapshot.status === 'failed' ? FAILURE_TTL_MS : RESULT_TTL_MS;
    this.results.set(connectionId, { snapshot, expiresAt: Date.now() + ttl });
    return snapshot;
  }

  private async run(connectionId: string, job: Job, nodes: SamplerNode[]): Promise<void> {
    let snapshot: CacheSimulatorSnapshot;
    try {
      const samples = await sampleNodes(nodes, {
        budget: SAMPLE_BUDGET,
        hardCap: SAMPLE_HARD_CAP,
        deadlineMs: SAMPLE_DEADLINE_MS,
        onProgress: (sampled) => {
          job.progress = { sampled, target: SAMPLE_BUDGET };
        },
      });
      snapshot = {
        status: 'ready',
        progress: null,
        instant: job.instant,
        estimate: estimate(samples, Date.now()),
        growth: job.growth,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${LABEL} sampling failed for ${connectionId}: ${message}`);
      snapshot = {
        status: 'failed',
        progress: null,
        instant: job.instant,
        estimate: null,
        growth: job.growth,
        error: message,
      };
    }
    if (this.jobs.get(connectionId) !== job) return;
    this.jobs.delete(connectionId);
    this.settle(connectionId, snapshot);
  }

  private inProgress(job: Job): CacheSimulatorSnapshot {
    return {
      status: 'sampling',
      progress: { ...job.progress },
      instant: job.instant,
      estimate: null,
      growth: job.growth,
    };
  }

  private prune(): void {
    for (const id of new Set([...this.jobs.keys(), ...this.results.keys()])) {
      if (this.registry.getConfig(id) !== null) continue;
      this.jobs.delete(id);
      this.results.delete(id);
    }
  }

  private async nodesFor(connectionId: string, seed: ScanNode): Promise<ScanNode[]> {
    const connections = this.registry.list();
    const connection = connections.find((candidate) => candidate.id === connectionId);
    const plan = connection ? collectionPlan(connection, connections) : { kind: 'single' as const };
    if (plan.kind !== 'cluster') return [seed];
    const nodes = await primaryNodes(
      clusterNodes(this.registry, seed, plan.members, this.logger, LABEL),
      this.logger,
      LABEL,
    );
    const expected = await this.primaryCount(seed);
    if (nodes.length < expected) {
      throw new Error(`Only ${nodes.length} of ${expected} cluster primaries are reachable, so the totals would be understated`);
    }
    return nodes;
  }

  private async primaryCount(seed: ScanNode): Promise<number> {
    const size = await seed.client.getClusterInfo().then(
      (info) => Number(info.cluster_size),
      (error: unknown) => {
        throw new Error(`Could not read the cluster size from ${seed.name}: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
    if (!Number.isInteger(size) || size < 1) throw new Error(`${seed.name} reported no cluster size, so the totals cannot be checked`);
    return size;
  }

  private async growth(nodes: ScanNode[]): Promise<CacheSimulatorGrowth | null> {
    const now = Date.now();
    const fits = await Promise.all(
      nodes.map((node) =>
        readGrowth(this.storage, node.id, now).catch((error: unknown) => {
          this.logger.warn(`${LABEL} growth history unavailable for ${node.id}: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }),
      ),
    );
    return sumGrowth(fits);
  }

  private async read(node: ScanNode): Promise<Reading> {
    const attempt = async (): Promise<Reading> => {
      const info = await node.client.getInfoParsed(['memory', 'keyspace']);
      const ownDb = node.client.getActiveDbIndex?.() ?? 0;
      return {
        node,
        stats: readInstantStats(info),
        keys: await node.client.getDbSize(),
        otherDbKeys: parseKeyspaceDatabases(info.keyspace).some(({ db }) => db !== ownDb),
      };
    };
    try {
      return await attempt();
    } catch (error) {
      this.logger.warn(`${LABEL} retrying INFO for ${node.id}: ${error instanceof Error ? error.message : String(error)}`);
      return attempt();
    }
  }
}

interface Reading {
  node: ScanNode;
  stats: InstantStats;
  keys: number;
  otherDbKeys: boolean;
}

function summarize(readings: Reading[]): CacheSimulatorInstant {
  const policies = new Set(readings.map((reading) => reading.stats.maxmemoryPolicy));
  const unlimited = readings.some((reading) => reading.stats.maxmemory === 0);
  return {
    usedMemory: readings.reduce((sum, reading) => sum + reading.stats.usedMemory, 0),
    maxmemory: unlimited ? 0 : readings.reduce((sum, reading) => sum + reading.stats.maxmemory, 0),
    maxmemoryPolicy: policies.size === 1 ? [...policies][0] : policies.size > 1 ? 'mixed' : 'unknown',
    totalKeys: readings.reduce((sum, reading) => sum + reading.keys, 0),
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
