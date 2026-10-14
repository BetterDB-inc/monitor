import { Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Feature, type KvCacheFootprintSnapshot } from '@betterdb/shared';
import { MultiConnectionPoller, type ConnectionContext } from '@app/common/services/multi-connection-poller';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { LicenseService } from '@proprietary/licenses/license.service';
import { collectionPlan, type CollectionPlan } from '../key-analytics/key-analytics-plan';
import { clusterScanNodes, primaryScanNodes, type ScanNode } from '../key-analytics/scan-nodes';
import { buildSnapshot, evictedKeysDelta, pickSample, type MemoryStats, type NodeObservation } from './footprint-estimate';
import { hasLmcacheGlideClient, otherNonEmptyDbs, readMemoryStats, sampleLmcacheKeys, scanLmcacheKeys } from './footprint-scanner';
import { classifyKey, maskKey } from './key-classifier';

export type SnapshotListener = (snapshot: KvCacheFootprintSnapshot) => void | Promise<void>;
export type RemovalListener = (connectionId: string) => void | Promise<void>;

interface NodeReading {
  observation: NodeObservation;
  memory: MemoryStats;
  otherDbs: number[];
  glide: boolean;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const MIN_FOOTPRINT_INTERVAL_MS = 60000;

export function resolvePositiveInt(raw: string | undefined, fallback: number, floor: number): number {
  const parsed = parseInt(raw ?? String(fallback), 10);
  return !Number.isFinite(parsed) || parsed < floor ? fallback : parsed;
}

@Injectable()
export class KvCacheFootprintService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(KvCacheFootprintService.name);
  private readonly intervalMs = resolvePositiveInt(
    process.env.KV_CACHE_FOOTPRINT_INTERVAL_MS,
    300000,
    MIN_FOOTPRINT_INTERVAL_MS,
  );
  private readonly budgets = {
    maxScanned: resolvePositiveInt(process.env.KV_CACHE_SCAN_MAX_KEYS, 200000, 1),
    maxMatched: resolvePositiveInt(process.env.KV_CACHE_MATCH_MAX_KEYS, 2000, 1),
  };
  private readonly sampleSize = resolvePositiveInt(process.env.KV_CACHE_SAMPLE_KEYS, 500, 1);
  private readonly undetectedRecheckMs = resolvePositiveInt(
    process.env.KV_CACHE_UNDETECTED_RECHECK_MS,
    1800000,
    MIN_FOOTPRINT_INTERVAL_MS,
  );
  private readonly running = new Map<string, Promise<KvCacheFootprintSnapshot | null>>();
  private readonly generations = new Map<string, number>();
  private readonly deleting = new Map<string, Promise<void>>();
  private readonly lastEvicted = new Map<string, Map<string, number>>();
  private readonly sampleKeys = new Map<string, string>();
  private readonly undetectedUntil = new Map<string, number>();
  private readonly listeners: SnapshotListener[] = [];
  private readonly removalListeners: RemovalListener[] = [];
  private readonly restoreListeners: RemovalListener[] = [];

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly license: LicenseService,
  ) {
    super(connectionRegistry);
  }

  async onModuleInit(): Promise<void> {
    this.start();
  }

  protected getIntervalMs(): number {
    return this.intervalMs;
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    if (!this.license.hasFeature(Feature.KV_CACHE_MONITORING)) return;
    if (Date.now() < (this.undetectedUntil.get(ctx.connectionId) ?? 0)) return;
    await this.collect(ctx);
  }

  protected onConnectionRemoved(connectionId: string): void {
    const active = this.running.get(connectionId);
    this.running.delete(connectionId);
    const generation = this.generationOf(connectionId) + 1;
    this.generations.set(connectionId, generation);
    this.lastEvicted.delete(connectionId);
    this.sampleKeys.delete(connectionId);
    this.undetectedUntil.delete(connectionId);
    const settled = active?.then(
      () => undefined,
      () => undefined,
    );
    const pending = this.removalListeners.map(async (listener) => {
      try {
        await listener(connectionId);
      } catch (error) {
        this.logger.warn(`KV cache removal listener failed: ${errorMessage(error)}`);
      }
    });
    void Promise.all([...pending, settled])
      .then(() => this.deleteRemovedData(connectionId, generation))
      .catch((error) => this.logger.warn(`Could not delete KV cache data for ${connectionId}: ${errorMessage(error)}`));
  }

  private async deleteRemovedData(connectionId: string, generation: number): Promise<void> {
    if (this.generationOf(connectionId) !== generation) return;
    if (this.isRegistered(connectionId)) return this.announceRestore(connectionId);
    if (!this.running.has(connectionId)) this.generations.delete(connectionId);
    const deletion = this.storage.deleteKvCacheConnectionData(connectionId);
    const settled = deletion.then(
      () => undefined,
      () => undefined,
    );
    this.deleting.set(connectionId, settled);
    try {
      await deletion;
    } finally {
      if (this.deleting.get(connectionId) === settled) this.deleting.delete(connectionId);
    }
  }

  private async announceRestore(connectionId: string): Promise<void> {
    for (const listener of this.restoreListeners) {
      try {
        await listener(connectionId);
      } catch (error) {
        this.logger.warn(`KV cache restore listener failed: ${errorMessage(error)}`);
      }
    }
  }

  private isRegistered(connectionId: string): boolean {
    return this.connectionRegistry.list().some((connection) => connection.id === connectionId);
  }

  onConnectionRemoval(listener: RemovalListener): void {
    this.removalListeners.push(listener);
  }

  onConnectionRestore(listener: RemovalListener): void {
    this.restoreListeners.push(listener);
  }

  onSnapshot(listener: SnapshotListener): void {
    this.listeners.push(listener);
  }

  getSampleKey(connectionId: string): string | null {
    return this.sampleKeys.get(connectionId) ?? null;
  }

  async triggerCollection(connectionId: string): Promise<KvCacheFootprintSnapshot | null> {
    const config = this.connectionRegistry.getConfig(connectionId);
    if (!config) throw new NotFoundException(`Connection '${connectionId}' not found`);
    const client = this.connectionRegistry.get(connectionId);
    return this.collect({
      connectionId,
      connectionName: config.name,
      client,
      host: config.host,
      port: config.port,
    });
  }

  async collect(ctx: ConnectionContext): Promise<KvCacheFootprintSnapshot | null> {
    await this.deleting.get(ctx.connectionId);
    const plan = this.planFor(ctx.connectionId);
    if (plan.kind === 'skip' || this.running.has(ctx.connectionId)) return null;
    const run = this.runCollection(ctx, plan);
    this.running.set(ctx.connectionId, run);
    try {
      return await run;
    } finally {
      if (this.running.get(ctx.connectionId) === run) this.running.delete(ctx.connectionId);
    }
  }

  private generationOf(connectionId: string): number {
    return this.generations.get(connectionId) ?? 0;
  }

  private async runCollection(ctx: ConnectionContext, plan: CollectionPlan): Promise<KvCacheFootprintSnapshot | null> {
    const generation = this.generationOf(ctx.connectionId);
    const current = () => this.generationOf(ctx.connectionId) === generation;
    const nodes = await this.nodesFor(ctx, plan);
    const ownDb = this.connectionRegistry.getConfig(ctx.connectionId)?.dbIndex ?? 0;
    const readings = await Promise.all(nodes.map((node) => this.read(node, ownDb)));
    const memory = this.sumMemory(readings.map((reading) => reading.memory));
    const evicted = new Map(nodes.map((node, index) => [node.name, readings[index].memory.evictedKeys]));
    const snapshot = buildSnapshot({
      connectionId: ctx.connectionId,
      timestamp: Date.now(),
      nodes: readings.map((reading) => reading.observation),
      memory,
      evictedKeysDelta: evictedKeysDelta(this.lastEvicted.get(ctx.connectionId), evicted),
      otherDbs: readings[0]?.otherDbs ?? [],
      clientDetected: readings.some((reading) => reading.glide),
    });
    await this.deleting.get(ctx.connectionId);
    if (!current()) return null;
    await this.storage.saveKvCacheFootprintSnapshot(snapshot);
    if (!current()) return null;
    this.lastEvicted.set(ctx.connectionId, new Map([...(this.lastEvicted.get(ctx.connectionId) ?? []), ...evicted]));
    if (snapshot.detected) this.undetectedUntil.delete(ctx.connectionId);
    else this.undetectedUntil.set(ctx.connectionId, snapshot.timestamp + this.undetectedRecheckMs);
    this.rememberSampleKey(ctx.connectionId, readings);
    await this.announce(snapshot);
    return snapshot;
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
