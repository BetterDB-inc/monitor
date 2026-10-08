import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Feature, type KvCacheFootprintSnapshot } from '@betterdb/shared';
import { MultiConnectionPoller, type ConnectionContext } from '@app/common/services/multi-connection-poller';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { LicenseService } from '@proprietary/licenses/license.service';
import { collectionPlan, type CollectionPlan } from '../key-analytics/key-analytics-plan';
import { clusterScanNodes, primaryScanNodes, type ScanNode } from '../key-analytics/scan-nodes';
import { buildSnapshot, pickSample, type MemoryStats, type NodeObservation } from './footprint-estimate';
import { hasLmcacheGlideClient, otherNonEmptyDbs, readMemoryStats, sampleLmcacheKeys, scanLmcacheKeys } from './footprint-scanner';
import { classifyKey, maskKey } from './key-classifier';

export type SnapshotListener = (snapshot: KvCacheFootprintSnapshot) => void | Promise<void>;

interface NodeReading {
  observation: NodeObservation;
  memory: MemoryStats;
  otherDbs: number[];
  glide: boolean;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

@Injectable()
export class KvCacheFootprintService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(KvCacheFootprintService.name);
  private readonly intervalMs = parseInt(process.env.KV_CACHE_FOOTPRINT_INTERVAL_MS || '300000', 10);
  private readonly budgets = {
    maxScanned: parseInt(process.env.KV_CACHE_SCAN_MAX_KEYS || '200000', 10),
    maxMatched: parseInt(process.env.KV_CACHE_MATCH_MAX_KEYS || '2000', 10),
  };
  private readonly sampleSize = parseInt(process.env.KV_CACHE_SAMPLE_KEYS || '500', 10);
  private readonly running = new Set<string>();
  private readonly lastEvicted = new Map<string, number>();
  private readonly sampleKeys = new Map<string, string>();
  private readonly listeners: SnapshotListener[] = [];

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly license: LicenseService,
  ) {
    super(connectionRegistry);
  }

  async onModuleInit(): Promise<void> {
    if (!this.license.hasFeature(Feature.KV_CACHE_MONITORING)) {
      this.logger.log('KV cache monitoring requires a Pro license - footprint collector disabled');
      return;
    }
    this.start();
  }

  protected getIntervalMs(): number {
    return this.intervalMs;
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    await this.collect(ctx);
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.running.delete(connectionId);
    this.lastEvicted.delete(connectionId);
    this.sampleKeys.delete(connectionId);
    void this.storage
      .deleteKvCacheConnectionData(connectionId)
      .catch((error) => this.logger.warn(`Could not delete KV cache data for ${connectionId}: ${errorMessage(error)}`));
  }

  onSnapshot(listener: SnapshotListener): void {
    this.listeners.push(listener);
  }

  getSampleKey(connectionId: string): string | null {
    return this.sampleKeys.get(connectionId) ?? null;
  }

  async triggerCollection(connectionId: string): Promise<KvCacheFootprintSnapshot | null> {
    const client = this.connectionRegistry.get(connectionId);
    const config = this.connectionRegistry.getConfig(connectionId);
    return this.collect({
      connectionId,
      connectionName: config?.name ?? connectionId,
      client,
      host: config?.host ?? '',
      port: config?.port ?? 0,
    });
  }

  async collect(ctx: ConnectionContext): Promise<KvCacheFootprintSnapshot | null> {
    const plan = this.planFor(ctx.connectionId);
    if (plan.kind === 'skip' || this.running.has(ctx.connectionId)) return null;
    this.running.add(ctx.connectionId);
    try {
      const nodes = await this.nodesFor(ctx, plan);
      const ownDb = this.connectionRegistry.getConfig(ctx.connectionId)?.dbIndex ?? 0;
      const readings = await Promise.all(nodes.map((node) => this.read(node, ownDb)));
      const memory = this.sumMemory(readings.map((reading) => reading.memory));
      const snapshot = buildSnapshot({
        connectionId: ctx.connectionId,
        timestamp: Date.now(),
        nodes: readings.map((reading) => reading.observation),
        memory,
        previousEvictedKeys: this.lastEvicted.get(ctx.connectionId) ?? null,
        otherDbs: readings[0]?.otherDbs ?? [],
        clientDetected: readings.some((reading) => reading.glide),
      });
      await this.storage.saveKvCacheFootprintSnapshot(snapshot);
      this.lastEvicted.set(ctx.connectionId, memory.evictedKeys);
      this.rememberSampleKey(ctx.connectionId, readings);
      await this.announce(snapshot);
      return snapshot;
    } finally {
      this.running.delete(ctx.connectionId);
    }
  }

  private planFor(connectionId: string): CollectionPlan {
    const connections = this.connectionRegistry.list();
    const connection = connections.find((candidate) => candidate.id === connectionId);
    return connection ? collectionPlan(connection, connections) : { kind: 'single' };
  }

  private async nodesFor(ctx: ConnectionContext, plan: CollectionPlan): Promise<ScanNode[]> {
    const seed = { name: ctx.connectionName, client: ctx.client };
    if (plan.kind !== 'cluster') return [seed];
    const nodes = await primaryScanNodes(
      clusterScanNodes(this.connectionRegistry, seed, plan.members, this.logger, 'KV cache'),
      this.logger,
      'KV cache',
    );
    if (nodes.length === 0) throw new Error(`No reachable primary found for ${ctx.connectionName}`);
    return nodes;
  }

  private async read(node: ScanNode, ownDb: number): Promise<NodeReading> {
    const dbSize = await node.client.getDbSize();
    const scan = await scanLmcacheKeys(node.client, this.budgets, dbSize);
    const samples = await sampleLmcacheKeys(node.client, pickSample(scan.matchedKeys, this.sampleSize));
    const info = await node.client.getInfoParsed(['memory', 'stats', 'keyspace']);
    return {
      observation: { ...scan, dbSize, samples },
      memory: readMemoryStats(info),
      otherDbs: otherNonEmptyDbs(info, ownDb),
      glide: await hasLmcacheGlideClient(node.client),
    };
  }

  private sumMemory(stats: MemoryStats[]): MemoryStats {
    return {
      usedMemory: stats.reduce((sum, s) => sum + s.usedMemory, 0),
      maxmemory: stats.reduce((sum, s) => sum + s.maxmemory, 0),
      maxmemoryPolicy: stats[0]?.maxmemoryPolicy ?? 'unknown',
      evictedKeys: stats.reduce((sum, s) => sum + s.evictedKeys, 0),
    };
  }

  private rememberSampleKey(connectionId: string, readings: NodeReading[]): void {
    const first = readings.flatMap((reading) => reading.observation.matchedKeys)[0];
    const parsed = first ? classifyKey(first) : null;
    if (parsed) this.sampleKeys.set(connectionId, maskKey(parsed));
    else this.sampleKeys.delete(connectionId);
  }

  private async announce(snapshot: KvCacheFootprintSnapshot): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(snapshot);
      } catch (error) {
        this.logger.warn(`KV cache snapshot listener failed: ${errorMessage(error)}`);
      }
    }
  }
}
