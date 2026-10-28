import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  Feature,
  type ConnectionStatus,
  type DatabaseConnectionConfig,
  type KvCacheFootprintSnapshot,
} from '@betterdb/shared';
import { MultiConnectionPoller, type ConnectionContext } from '@app/common/services/multi-connection-poller';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import { downsampleSeries } from '@app/common/utils/downsample';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { parseKeyspaceDatabases } from '@app/database/parsers/keyspace-databases';
import { LicenseService } from '@proprietary/licenses/license.service';
import { resolvePlan, type CollectionPlan } from '../key-analytics/key-analytics-plan';
import type { ClusterNode } from '@app/common/types/metrics.types';
import { clusterScanNodes, primaryScanNodes, type ScanNode } from '../key-analytics/scan-nodes';
import {
  buildSnapshot,
  DETECTION_MIN_MATCHES,
  evictedKeysDelta,
  type KeySample,
  type MemoryStats,
  type NodeObservation,
  type ScanCoverage,
} from './footprint-estimate';
import {
  hasLmcacheGlideClient,
  readMemoryStats,
  sampleLmcacheKeys,
  scanLmcacheKeys,
  type ScanResult,
} from './footprint-scanner';
import { hasSingleKeyEvidence, hasTwoKeyEvidence, maskKey, resolveTagSuffixes } from './key-classifier';
import { slotOwner, type SlotOwnership } from './key-slot';

export interface SnapshotContext {
  partial: boolean;
}

export type SnapshotListener = (snapshot: KvCacheFootprintSnapshot, context: SnapshotContext) => void | Promise<void>;
export type RemovalListener = (connectionId: string) => void | Promise<void>;

interface NodeReading {
  nodeKey: string;
  observation: NodeObservation;
  memory: MemoryStats;
  otherDbs: number[];
  glide: boolean;
}

interface NodeScan {
  node: ScanNode;
  scan: ScanResult & { dbSize: number };
  memory: MemoryStats;
  otherDbs: number[];
}

interface SlotView {
  owners: number;
  ownedSlots: number;
  slotsByNode: number[];
  rangesByNode: number[][][];
}

interface ScanTargets {
  nodes: ScanNode[];
  skipped: number;
  slots?: SlotView;
  replicaSeed?: boolean;
}

const slotCount = (peer: ClusterNode) =>
  peer.slots.reduce((sum, range) => sum + (range[range.length - 1] - range[0] + 1), 0);

function peerAddresses(peer: ClusterNode): string[] {
  const hostPort = (peer.address ?? '').split('@')[0];
  const port = hostPort.slice(hostPort.lastIndexOf(':') + 1);
  return peer.hostname ? [hostPort, `${peer.hostname}:${port}`] : [hostPort];
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const MIN_FOOTPRINT_INTERVAL_MS = 60000;
export const MAX_FOOTPRINT_INTERVAL_MS = 86_400_000;
export const PARTIAL_MISSES_BEFORE_CLEAR = 3;
export const REFRESH_REUSE_MS = 10_000;

export function resolvePositiveInt(
  raw: string | undefined,
  fallback: number,
  floor: number,
  onInvalid?: (raw: string) => void,
  ceiling = Number.MAX_SAFE_INTEGER,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= floor && parsed <= ceiling) return parsed;
  onInvalid?.(raw);
  return fallback;
}

@Injectable()
export class KvCacheFootprintService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(KvCacheFootprintService.name);
  private readonly intervalMs = this.setting(
    'KV_CACHE_FOOTPRINT_INTERVAL_MS',
    300000,
    MIN_FOOTPRINT_INTERVAL_MS,
    MAX_FOOTPRINT_INTERVAL_MS,
  );
  private readonly budgets = {
    maxScanned: this.setting('KV_CACHE_SCAN_MAX_KEYS', 200000, 1),
    maxMatched: this.setting('KV_CACHE_MATCH_MAX_KEYS', 2000, DETECTION_MIN_MATCHES),
  };
  private readonly sampleSize = this.setting('KV_CACHE_SAMPLE_KEYS', 500, 1);
  private readonly undetectedRecheckMs = this.setting(
    'KV_CACHE_UNDETECTED_RECHECK_MS',
    1800000,
    MIN_FOOTPRINT_INTERVAL_MS,
  );
  private readonly running = new Map<string, Promise<KvCacheFootprintSnapshot | null>>();
  private readonly generations = new Map<string, number>();
  private readonly deleting = new Map<string, Promise<void>>();
  private readonly removing = new Map<string, Promise<void>>();
  private readonly announcing = new Map<string, Promise<void>>();
  private readonly lastEvicted = new Map<string, { timestamp: number; counts: Map<string, number> }>();
  private readonly sampleKeys = new Map<string, string>();
  private readonly undetectedUntil = new Map<string, number>();
  private readonly undetected = new Set<string>();
  private readonly partialMisses = new Map<string, number>();
  private retired = new Set<string>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private unsubscribeRemoval: (() => void) | null = null;
  private readonly memoryBlocked = new Set<string>();
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
    this.unsubscribeRemoval = this.connectionRegistry.addConnectionRemovalListener((id) => this.forget(id));
    void this.license
      .ensureValidated()
      .finally(() => this.start())
      .catch((error) => this.logger.error(`KV cache footprint start failed: ${errorMessage(error)}`));
    this.sweepDeletedRetirees();
    this.sweepTimer = setInterval(() => this.sweepDeletedRetirees(), this.intervalMs);
    this.sweepTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.unsubscribeRemoval?.();
    this.unsubscribeRemoval = null;
    await super.onModuleDestroy();
  }

  private setting(name: string, fallback: number, floor: number, ceiling?: number): number {
    const range = ceiling === undefined ? `>= ${floor}` : `between ${floor} and ${ceiling}`;
    return resolvePositiveInt(
      process.env[name],
      fallback,
      floor,
      (raw) => this.logger.warn(`Ignoring ${name}='${raw}': expected an integer ${range}, using ${fallback}`),
      ceiling,
    );
  }

  protected getIntervalMs(): number {
    return this.intervalMs;
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    if (!this.license.hasFeature(Feature.KV_CACHE_MONITORING)) return;
    if (Date.now() < (this.undetectedUntil.get(ctx.connectionId) ?? 0)) return;
    await this.collect(ctx);
  }

  private forget(connectionId: string): void {
    const active = this.running.get(connectionId);
    this.running.delete(connectionId);
    const generation = this.generationOf(connectionId) + 1;
    this.generations.set(connectionId, generation);
    this.lastEvicted.delete(connectionId);
    this.sampleKeys.delete(connectionId);
    this.undetectedUntil.delete(connectionId);
    this.undetected.delete(connectionId);
    this.partialMisses.delete(connectionId);
    const settled = active?.then(
      () => undefined,
      () => undefined,
    );
    const announcing = this.announcing.get(connectionId);
    const removed = announcing
      ? announcing.then(() => this.announceRemoval(connectionId))
      : this.announceRemoval(connectionId);
    const removal = removed.then(
      () => undefined,
      () => undefined,
    );
    this.removing.set(connectionId, removal);
    void removal.then(() => {
      if (this.removing.get(connectionId) === removal) this.removing.delete(connectionId);
    });
    void Promise.all([removed, settled])
      .then(() => this.deleteRemovedData(connectionId, generation))
      .catch((error) => this.logger.warn(`Could not delete KV cache data for ${connectionId}: ${errorMessage(error)}`));
  }

  private async announceRemoval(connectionId: string): Promise<void> {
    await Promise.all(
      this.removalListeners.map(async (listener) => {
        try {
          await listener(connectionId);
        } catch (error) {
          this.logger.warn(`KV cache removal listener failed: ${errorMessage(error)}`);
        }
      }),
    );
  }

  private sweepDeletedRetirees(): void {
    const all = this.connectionRegistry.list({ includeRetired: true }).map((connection) => connection.id);
    const live = new Set(this.connectionRegistry.list().map((connection) => connection.id));
    const known = new Set(all);
    const deleted = [...this.retired].filter((id) => !known.has(id));
    this.retired = new Set(all.filter((id) => !live.has(id)));
    for (const id of deleted) this.forget(id);
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
    return this.connectionRegistry.list({ includeRetired: true }).some((connection) => connection.id === connectionId);
  }

  hasConnection(connectionId: string): boolean {
    return Boolean(this.connectionRegistry.getConfig(connectionId));
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

  getFootprintIntervalMs(): number {
    return this.intervalMs;
  }

  getSampleKey(connectionId: string): string | null {
    return this.sampleKeys.get(connectionId) ?? null;
  }

  async triggerCollection(connectionId: string): Promise<KvCacheFootprintSnapshot | null> {
    const target = this.target(connectionId);
    if (!target) throw new NotFoundException(`Connection '${connectionId}' not found`);
    if (target.rejection) throw new BadRequestException(target.rejection);
    if (target.connection && !target.connection.isConnected) {
      throw new ServiceUnavailableException(`Connection '${connectionId}' is not connected`);
    }
    const running = this.running.get(connectionId);
    if (running) return running;
    const recent = await this.recentSnapshot(connectionId);
    if (recent) return recent;
    const { config, plan } = target;
    const client = this.connectionRegistry.get(connectionId);
    return this.collectWith(
      { connectionId, connectionName: config.name, client, host: config.host, port: config.port },
      plan,
    );
  }

  async collect(ctx: ConnectionContext): Promise<KvCacheFootprintSnapshot | null> {
    await this.deleting.get(ctx.connectionId);
    const target = this.target(ctx.connectionId);
    if (!target || target.rejection) return null;
    return this.collectWith(ctx, target.plan);
  }

  private target(
    connectionId: string,
  ): {
    config: DatabaseConnectionConfig;
    connection: ConnectionStatus | undefined;
    plan: CollectionPlan;
    rejection: string | null;
  } | null {
    const config = this.connectionRegistry.getConfig(connectionId);
    if (!config) return null;
    const { connection, plan } = resolvePlan(this.connectionRegistry, connectionId);
    return { config, connection, plan, rejection: this.rejection(connectionId, config, connection, plan) };
  }

  private async recentSnapshot(connectionId: string): Promise<KvCacheFootprintSnapshot | null> {
    const [latest] = await this.storage.getKvCacheFootprintSnapshots({ connectionId, limit: 1 });
    return latest && Date.now() - latest.timestamp < REFRESH_REUSE_MS ? latest : null;
  }

  private rejection(
    connectionId: string,
    config: DatabaseConnectionConfig,
    connection: ConnectionStatus | undefined,
    plan: CollectionPlan,
  ): string | null {
    if (this.isSentinelConnection(connectionId)) return 'Sentinel connections have no keyspace to scan';
    if (config.host === 'agent') return 'KV cache footprint is not available for agent connections';
    if (config.connectionType === 'external') return 'KV cache footprint is not available for external connections';
    if (connection?.membership?.retiredAt !== undefined) return 'This node has been retired from its topology';
    if (plan.kind === 'skip') return 'KV cache footprint for this node is collected through its seed or primary connection';
    return null;
  }

  private async collectWith(ctx: ConnectionContext, plan: CollectionPlan): Promise<KvCacheFootprintSnapshot | null> {
    await this.deleting.get(ctx.connectionId);
    if (!this.connectionRegistry.getConfig(ctx.connectionId)) return null;
    const running = this.running.get(ctx.connectionId);
    if (running) return running;
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
    const targets = await this.nodesFor(ctx, plan);
    const { nodes, skipped } = targets;
    const probe = this.undetected.has(ctx.connectionId);
    const settled = await this.readAll(nodes, probe, targets.slots?.rangesByNode.map(slotOwner), targets.replicaSeed === true);
    const readings: NodeReading[] = [];
    const readIndexes: number[] = [];
    const evicted = new Map<string, number>();
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        readings.push(result.value);
        readIndexes.push(index);
        evicted.set(result.value.nodeKey, result.value.memory.evictedKeys);
      } else {
        this.logger.warn(`KV cache read failed on ${nodes[index].name}: ${errorMessage(result.reason)}`);
      }
    });
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (readings.length === 0 && failed) throw failed.reason;
    const memory = this.sumMemory(readings.map((reading) => reading.memory));
    const timestamp = Date.now();
    const previousEvicted = this.lastEvicted.get(ctx.connectionId);
    const built = buildSnapshot({
      connectionId: ctx.connectionId,
      timestamp,
      nodes: readings.map((reading) => reading.observation),
      memory,
      evictedKeysDelta: evictedKeysDelta(previousEvicted?.counts, evicted),
      evictedKeysIntervalMs: previousEvicted ? timestamp - previousEvicted.timestamp : null,
      otherDbs: readings[0]?.otherDbs ?? [],
      clientDetected: readings.some((reading) => reading.glide),
      coverage: this.coverage(targets, readIndexes),
    });
    const partial = failed !== undefined || skipped > 0;
    const missed = partial && !built.detected;
    const misses = missed ? (this.partialMisses.get(ctx.connectionId) ?? 0) + 1 : 0;
    const detected = missed ? await this.carriedDetection(ctx.connectionId, misses) : built.detected;
    const keepsEarlier = partial && detected;
    const snapshot = partial ? { ...built, scanComplete: false, detected } : built;
    await this.deleting.get(ctx.connectionId);
    if (current()) await this.removing.get(ctx.connectionId);
    const live = () => current() && Boolean(this.connectionRegistry.getConfig(ctx.connectionId));
    if (!live()) return null;
    await this.storage.saveKvCacheFootprintSnapshot(snapshot);
    if (!live()) return null;
    this.lastEvicted.set(ctx.connectionId, { timestamp, counts: evicted });
    if (missed) this.partialMisses.set(ctx.connectionId, misses);
    else this.partialMisses.delete(ctx.connectionId);
    if (built.detected) {
      this.undetectedUntil.delete(ctx.connectionId);
      this.undetected.delete(ctx.connectionId);
    } else if (!snapshot.detected && (!partial || misses >= PARTIAL_MISSES_BEFORE_CLEAR)) {
      this.undetectedUntil.set(ctx.connectionId, snapshot.timestamp + this.undetectedRecheckMs);
      this.undetected.add(ctx.connectionId);
    }
    this.rememberSampleKey(ctx.connectionId, readings, keepsEarlier);
    const announced = this.announce(snapshot, { partial });
    this.announcing.set(ctx.connectionId, announced);
    try {
      await announced;
    } finally {
      if (this.announcing.get(ctx.connectionId) === announced) this.announcing.delete(ctx.connectionId);
    }
    return snapshot;
  }

  private async nodesFor(ctx: ConnectionContext, plan: CollectionPlan): Promise<ScanTargets> {
    const seed = { name: ctx.connectionName, client: ctx.client, connectionId: ctx.connectionId };
    if (plan.kind !== 'cluster') {
      return this.isClusterMode(seed) ? this.withClusterView([seed]) : { nodes: [seed], skipped: 0 };
    }
    const registered = clusterScanNodes(this.connectionRegistry, seed, plan.members, this.logger, 'KV cache');
    const nodes = await primaryScanNodes(registered, this.logger, 'KV cache');
    if (nodes.length === 0) throw new Error(`No reachable primary found for ${ctx.connectionName}`);
    return this.withClusterView(nodes);
  }

  private async withClusterView(nodes: ScanNode[]): Promise<ScanTargets> {
    const [viewer] = nodes;
    try {
      const view = await viewer.client.getClusterNodes();
      const self = view.find((peer) => peer.flags.includes('myself'));
      const myself = self?.id;
      const owners = view.filter((peer) => this.ownsSlots(peer));
      const ids = nodes.map((node, index) => this.ownerId(node, owners, index === 0 ? myself : undefined));
      const scanned = new Set(ids);
      const slotsOf = new Map(owners.map((peer) => [peer.id, slotCount(peer)]));
      const rangesOf = new Map(owners.map((peer) => [peer.id, peer.slots]));
      return {
        nodes,
        replicaSeed: self?.flags.includes('slave') === true,
        skipped: owners.filter((peer) => !scanned.has(peer.id)).length,
        slots: {
          owners: owners.length,
          ownedSlots: owners.reduce((sum, peer) => sum + slotCount(peer), 0),
          slotsByNode: ids.map((id) => (id === undefined ? 0 : (slotsOf.get(id) ?? 0))),
          rangesByNode: ids.map((id) => (id === undefined ? [] : (rangesOf.get(id) ?? []))),
        },
      };
    } catch (error) {
      this.logger.warn(`KV cache could not read the cluster view from ${viewer.name}: ${errorMessage(error)}`);
      return { nodes, skipped: 1 };
    }
  }

  private coverage({ nodes, skipped, slots }: ScanTargets, readIndexes: number[]): ScanCoverage {
    const primariesScanned = readIndexes.length;
    if (!slots) {
      return {
        primariesScanned,
        primariesTotal: skipped === 0 ? nodes.length : null,
        slotShare: skipped === 0 && primariesScanned === nodes.length ? 1 : null,
      };
    }
    const scannedSlots = readIndexes.reduce((sum, index) => sum + slots.slotsByNode[index], 0);
    return {
      primariesScanned: readIndexes.filter((index) => slots.slotsByNode[index] > 0).length,
      primariesTotal: slots.owners,
      slotShare: slots.ownedSlots > 0 && readIndexes.every((index) => slots.slotsByNode[index] > 0) ? scannedSlots / slots.ownedSlots : null,
    };
  }

  private ownerId(node: ScanNode, owners: ClusterNode[], myself: string | undefined): string | undefined {
    const stored = node.nodeId ?? myself;
    const owned = [node.nodeId, myself].find((id) => id !== undefined && owners.some((peer) => peer.id === id));
    if (owned !== undefined) return owned;
    const config = node.connectionId ? this.connectionRegistry.getConfig(node.connectionId) : undefined;
    const byAddress = config && owners.find((peer) => peerAddresses(peer).includes(`${config.host}:${config.port}`));
    return byAddress?.id ?? stored;
  }

  private ownsSlots(peer: ClusterNode): boolean {
    return peer.flags.includes('master') && peer.slots.length > 0;
  }

  private isClusterMode(node: ScanNode): boolean {
    try {
      return node.client.getCapabilities().clusterEnabled === true;
    } catch {
      return false;
    }
  }

  private async readAll(
    nodes: ScanNode[],
    probe: boolean,
    ownership?: SlotOwnership[],
    replicaSeed = false,
  ): Promise<PromiseSettledResult<NodeReading>[]> {
    const scanned = await Promise.allSettled(nodes.map((node) => this.scanNode(node, probe)));
    const runKeys = scanned.flatMap((result) => (result.status === 'fulfilled' ? result.value.scan.matchedKeys : []));
    const evidence = { twoKey: hasTwoKeyEvidence(runKeys), singleKey: hasSingleKeyEvidence(runKeys) };
    const checkClients = runKeys.length < DETECTION_MIN_MATCHES;
    return Promise.allSettled(
      scanned.map((result, index) =>
        result.status === 'fulfilled'
          ? this.sampleNode(result.value, evidence, checkClients, ownership?.[index], replicaSeed && index === 0)
          : Promise.reject(result.reason),
      ),
    );
  }

  private async carriedDetection(connectionId: string, misses: number): Promise<boolean> {
    if (misses >= PARTIAL_MISSES_BEFORE_CLEAR) return false;
    const [previous] = await this.storage.getKvCacheFootprintSnapshots({ connectionId, limit: 1 });
    return previous?.detected === true;
  }

  private async scanNode(node: ScanNode, probe: boolean): Promise<NodeScan> {
    const [scan, info] = await Promise.all([
      this.scanKeys(node, probe),
      node.client.getInfoParsed(['memory', 'stats', 'keyspace']),
    ]);
    const ownDb = node.client.getActiveDbIndex?.() ?? 0;
    return {
      node,
      scan,
      memory: readMemoryStats(info),
      otherDbs: parseKeyspaceDatabases(info.keyspace)
        .map(({ db }) => db)
        .filter((db) => db !== ownDb),
    };
  }

  private async scanKeys(node: ScanNode, probe: boolean): Promise<ScanResult & { dbSize: number }> {
    const dbSize = await node.client.getDbSize();
    return { ...(await scanLmcacheKeys(node.client, this.budgets, dbSize, probe)), dbSize };
  }

  private async sampleNode(
    { node, scan, ...rest }: NodeScan,
    { twoKey, singleKey }: { twoKey: boolean; singleKey: boolean },
    checkClients: boolean,
    ownsSlot?: SlotOwnership,
    replica = false,
  ): Promise<NodeReading> {
    const matchedKeys = resolveTagSuffixes(scan.matchedKeys, twoKey, singleKey);
    const [samples, glide] = await Promise.all([
      replica ? ([] as KeySample[]) : sampleLmcacheKeys(node.client, downsampleSeries(matchedKeys, this.sampleSize), ownsSlot),
      checkClients ? hasLmcacheGlideClient(node.client, node.client.getActiveDbIndex?.() ?? 0) : false,
    ]);
    this.noteMemoryAccess(node.name, samples.length > 0 && samples.every((sample) => sample.memoryBytes === null));
    return { ...rest, glide, nodeKey: node.connectionId ?? node.name, observation: { ...scan, matchedKeys, samples } };
  }

  private noteMemoryAccess(nodeName: string, blocked: boolean): void {
    if (!blocked) {
      this.memoryBlocked.delete(nodeName);
      return;
    }
    if (this.memoryBlocked.has(nodeName)) return;
    this.memoryBlocked.add(nodeName);
    this.logger.warn(`MEMORY USAGE returned nothing on ${nodeName}; KV cache byte estimates will read as unknown`);
  }

  private sumMemory(stats: MemoryStats[]): MemoryStats {
    const policies = new Set(stats.map((s) => s.maxmemoryPolicy));
    const unlimited = stats.some((s) => s.maxmemory === 0);
    return {
      usedMemory: stats.reduce((sum, s) => sum + s.usedMemory, 0),
      maxmemory: unlimited ? 0 : stats.reduce((sum, s) => sum + s.maxmemory, 0),
      maxmemoryPolicy: policies.size > 1 ? 'mixed' : (stats[0]?.maxmemoryPolicy ?? 'unknown'),
      evictedKeys: stats.reduce((sum, s) => sum + s.evictedKeys, 0),
    };
  }

  private rememberSampleKey(connectionId: string, readings: NodeReading[], keepsEarlier: boolean): void {
    const parsed = readings.flatMap((reading) => reading.observation.matchedKeys)[0];
    if (parsed) this.sampleKeys.set(connectionId, maskKey(parsed));
    else if (!keepsEarlier) this.sampleKeys.delete(connectionId);
  }

  private async announce(snapshot: KvCacheFootprintSnapshot, context: SnapshotContext): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(snapshot, context);
      } catch (error) {
        this.logger.warn(`KV cache snapshot listener failed: ${errorMessage(error)}`);
      }
    }
  }
}
