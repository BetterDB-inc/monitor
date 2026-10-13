import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CacheSimulatorGrowth, CacheSimulatorInstant, CacheSimulatorSnapshot } from '@betterdb/shared';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { collectionPlan } from '../key-analytics/key-analytics-plan';
import { clusterNodes, primaryNodes, type ScanNode } from './cluster-nodes';
import { readInstantStats, type InstantStats } from './instant-stats';
import { readGrowth, sumGrowth } from './growth-fit';
import { estimate, keyMemoryCeiling } from './size-estimator';
import { sampleNodes, SAMPLE_BUDGET, SAMPLE_DEADLINE_MS, SAMPLE_HARD_CAP } from './stratified-sampler';

export const RESULT_TTL_MS = 15 * 60_000;
export const FAILURE_TTL_MS = 60_000;
export const SETUP_TIMEOUT_MS = 30_000;
const LABEL = 'Cache simulator';

interface Job {
  instant: CacheSimulatorInstant;
  ceiling: number | undefined;
  growth: CacheSimulatorGrowth | null;
  progress: { sampled: number; target: number };
}

@Injectable()
export class CacheSimulatorService {
  private readonly logger = new Logger(CacheSimulatorService.name);
  private readonly jobs = new Map<string, Job>();
  private readonly starting = new Map<string, Promise<CacheSimulatorSnapshot>>();
  private readonly results = new Map<string, { snapshot: CacheSimulatorSnapshot; at: number }>();

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
    if (cached && !refresh && Date.now() - cached.at < this.ttl(cached.snapshot)) return cached.snapshot;
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

  private async prepare(connectionId: string, seed: ScanNode): Promise<{ job: Job; nodes: ScanNode[] }> {
    const nodes = await this.nodesFor(connectionId, seed);
    const [readings, growth] = await Promise.all([Promise.all(nodes.map((node) => this.read(node))), this.growth(nodes)]);
    const instant = summarize(readings);
    const dataset = readings.every((reading) => reading.stats.datasetMemory !== null)
      ? readings.reduce((sum, reading) => sum + (reading.stats.datasetMemory ?? 0), 0)
      : null;
    const ceiling = dataset === null ? undefined : keyMemoryCeiling(dataset, instant.totalKeys);
    return { job: { instant, ceiling, growth, progress: { sampled: 0, target: SAMPLE_BUDGET } }, nodes };
  }

  private settle(connectionId: string, snapshot: CacheSimulatorSnapshot): CacheSimulatorSnapshot {
    if (this.registry.getConfig(connectionId) === null) return snapshot;
    const cached = this.results.get(connectionId);
    if (snapshot.status === 'failed' && cached?.snapshot.status === 'ready') {
      const kept = { ...cached.snapshot, error: snapshot.error };
      this.results.set(connectionId, { snapshot: kept, at: cached.at });
      return kept;
    }
    this.results.set(connectionId, { snapshot, at: Date.now() });
    return snapshot;
  }

  private async run(connectionId: string, job: Job, nodes: ScanNode[]): Promise<void> {
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
        estimate: estimate(samples, Date.now(), job.ceiling),
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

  private ttl(snapshot: CacheSimulatorSnapshot): number {
    return snapshot.status === 'failed' ? FAILURE_TTL_MS : RESULT_TTL_MS;
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
    return nodes.length > 0 ? nodes : [seed];
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
    const attempt = async (): Promise<Reading> => ({
      stats: readInstantStats(await node.client.getInfoParsed(['memory'])),
      keys: await node.client.getDbSize(),
    });
    try {
      return await attempt();
    } catch (error) {
      this.logger.warn(`${LABEL} retrying INFO for ${node.id}: ${error instanceof Error ? error.message : String(error)}`);
      return attempt();
    }
  }
}

interface Reading {
  stats: InstantStats;
  keys: number;
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
