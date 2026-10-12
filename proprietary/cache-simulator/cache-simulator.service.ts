import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CacheSimulatorGrowth, CacheSimulatorInstant, CacheSimulatorSnapshot } from '@betterdb/shared';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { collectionPlan } from '../key-analytics/key-analytics-plan';
import { clusterNodes, primaryNodes, type ScanNode } from './cluster-nodes';
import { readInstantStats } from './instant-stats';
import { readGrowth } from './growth-fit';
import { estimate } from './size-estimator';
import { sampleNodes, SAMPLE_BUDGET, SAMPLE_DEADLINE_MS, SAMPLE_HARD_CAP } from './stratified-sampler';

export const RESULT_TTL_MS = 15 * 60_000;
export const FAILURE_TTL_MS = 60_000;
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
    const cached = this.results.get(connectionId);
    if (cached && !refresh && Date.now() - cached.at < this.ttl(cached.snapshot)) return cached.snapshot;
    const name = this.registry.getConfig(connectionId)?.name ?? connectionId;
    const nodes = await this.nodesFor(connectionId, { name, client });
    const [instant, growth] = await Promise.all([
      this.instant(nodes),
      readGrowth(this.storage, connectionId, Date.now()),
    ]);
    const job: Job = { instant, growth, progress: { sampled: 0, target: SAMPLE_BUDGET } };
    this.jobs.set(connectionId, job);
    void this.run(connectionId, job, nodes);
    return this.inProgress(job);
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
    if (this.registry.getConfig(connectionId) === null) return;
    this.results.set(connectionId, { snapshot, at: Date.now() });
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

  private async instant(nodes: ScanNode[]): Promise<CacheSimulatorInstant> {
    const readings = await Promise.all(
      nodes.map(async (node) => ({
        stats: readInstantStats(await node.client.getInfoParsed(['memory', 'stats'])),
        keys: await node.client.getDbSize(),
      })),
    );
    return {
      usedMemory: readings.reduce((sum, reading) => sum + reading.stats.usedMemory, 0),
      maxmemory: readings.reduce((sum, reading) => sum + reading.stats.maxmemory, 0),
      maxmemoryPolicy: readings[0]?.stats.maxmemoryPolicy ?? 'unknown',
      totalKeys: readings.reduce((sum, reading) => sum + reading.keys, 0),
    };
  }
}
