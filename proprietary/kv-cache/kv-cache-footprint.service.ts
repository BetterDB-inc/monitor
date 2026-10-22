import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
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

export type SnapshotListener = (snapshot: KvCacheFootprintSnapshot) => void | Promise<void>;

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
    maxMatched: this.setting('KV_CACHE_MATCH_MAX_KEYS', 2000, 1),
  };
  private readonly sampleSize = this.setting('KV_CACHE_SAMPLE_KEYS', 500, 1);
  private readonly undetectedRecheckMs = this.setting(
    'KV_CACHE_UNDETECTED_RECHECK_MS',
    1800000,
    MIN_FOOTPRINT_INTERVAL_MS,
  );
  private readonly inFlight = new Map<string, Promise<KvCacheFootprintSnapshot | null>>();
  private readonly lastEvicted = new Map<string, { timestamp: number; counts: Record<string, number> }>();
  private unsubscribeRemoval: (() => void) | null = null;
  private readonly sampleKeys = new Map<string, string>();
  private readonly undetectedUntil = new Map<string, number>();
  private readonly partialMisses = new Map<string, number>();
  private readonly listeners: SnapshotListener[] = [];

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly license: LicenseService,
  ) {
    super(connectionRegistry);
  }

  async onModuleInit(): Promise<void> {
    this.unsubscribeRemoval = this.connectionRegistry.addConnectionRemovalListener((id) => this.forget(id));
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
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

  private async forget(connectionId: string): Promise<void> {
    await this.inFlight.get(connectionId)?.catch(() => null);
    this.lastEvicted.delete(connectionId);
    this.sampleKeys.delete(connectionId);
    this.undetectedUntil.delete(connectionId);
    this.partialMisses.delete(connectionId);
    await this.storage
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
    const target = this.target(connectionId);
    if (!target) throw new NotFoundException(`Connection '${connectionId}' not found`);
    if (target.rejection) throw new BadRequestException(target.rejection);
    const running = this.inFlight.get(connectionId);
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
    const target = this.target(ctx.connectionId);
    if (!target || target.rejection) return null;
    return this.collectWith(ctx, target.plan);
  }

  private target(
    connectionId: string,
  ): { config: DatabaseConnectionConfig; plan: CollectionPlan; rejection: string | null } | null {
    const config = this.connectionRegistry.getConfig(connectionId);
    if (!config) return null;
    const { connection, plan } = resolvePlan(this.connectionRegistry, connectionId);
    return { config, plan, rejection: this.rejection(connectionId, config, connection, plan) };
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
    if (config.host === 'agent') return 'KV cache footprint is not available for agent connections';
    if (config.connectionType === 'external') return 'KV cache footprint is not available for external connections';
    if (connection?.isConnected === false) return 'The connection is not connected';
    if (this.isSentinelConnection(connectionId)) return 'Sentinel connections have no keyspace to scan';
    if (connection?.membership?.retiredAt !== undefined) return 'This node has been retired from its topology';
    if (plan.kind === 'skip') return 'KV cache footprint for this node is collected through its seed or primary connection';
    return null;
  }

  private async collectWith(ctx: ConnectionContext, plan: CollectionPlan): Promise<KvCacheFootprintSnapshot | null> {
    const running = this.inFlight.get(ctx.connectionId);
    if (running) return running;
    const run = this.run(ctx, plan);
    this.inFlight.set(ctx.connectionId, run);
    try {
      return await run;
    } finally {
      this.inFlight.delete(ctx.connectionId);
    }
  }

  private async run(ctx: ConnectionContext, plan: CollectionPlan): Promise<KvCacheFootprintSnapshot> {
    const targets = await this.nodesFor(ctx, plan);
    const { nodes, skipped } = targets;
    const settled = await this.readAll(nodes, targets.slots?.rangesByNode.map(slotOwner), targets.replicaSeed === true);
    const readings: NodeReading[] = [];
    const readIndexes: number[] = [];
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        readings.push(result.value);
        readIndexes.push(index);
      } else this.logger.warn(`KV cache read failed on ${nodes[index].name}: ${errorMessage(result.reason)}`);
    });
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (readings.length === 0 && failed) throw failed.reason;
    const partial = failed !== undefined || skipped > 0;
    const memory = this.sumMemory(readings.map((reading) => reading.memory));
    const evicted = Object.fromEntries(readings.map((reading) => [reading.nodeKey, reading.memory.evictedKeys]));
    const timestamp = Date.now();
    const previousEvicted = this.lastEvicted.get(ctx.connectionId);
    const built = buildSnapshot({
      connectionId: ctx.connectionId,
      timestamp,
      nodes: readings.map((reading) => reading.observation),
      memory,
      evictedKeysDelta: evictedKeysDelta(previousEvicted?.counts ?? null, evicted),
      evictedKeysIntervalMs: previousEvicted ? timestamp - previousEvicted.timestamp : null,
      otherDbs: readings[0]?.otherDbs ?? [],
      clientDetected: readings.some((reading) => reading.glide),
      coverage: this.coverage(targets, readIndexes),
    });
    const detected = partial && !built.detected ? await this.carriedDetection(ctx.connectionId) : built.detected;
    if (!partial || built.detected) this.partialMisses.delete(ctx.connectionId);
    const keepsEarlier = partial && detected;
    const snapshot = partial ? { ...built, scanComplete: false, detected } : built;
    await this.storage.saveKvCacheFootprintSnapshot(snapshot);
    this.lastEvicted.set(ctx.connectionId, { timestamp, counts: evicted });
    if (built.detected) this.undetectedUntil.delete(ctx.connectionId);
    else if (!snapshot.detected && (!partial || this.partialMissesExhausted(ctx.connectionId))) {
      this.undetectedUntil.set(ctx.connectionId, snapshot.timestamp + this.undetectedRecheckMs);
    }
    this.rememberSampleKey(ctx.connectionId, readings, keepsEarlier);
    await this.announce(snapshot);
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
    ownership?: SlotOwnership[],
    replicaSeed = false,
  ): Promise<PromiseSettledResult<NodeReading>[]> {
    const scanned = await Promise.allSettled(nodes.map((node) => this.scanNode(node)));
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

  private async scanNode(node: ScanNode): Promise<NodeScan> {
    const [scan, info] = await Promise.all([this.scanKeys(node), node.client.getInfoParsed(['memory', 'stats', 'keyspace'])]);
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

  private async scanKeys(node: ScanNode): Promise<ScanResult & { dbSize: number }> {
    const dbSize = await node.client.getDbSize();
    return { ...(await scanLmcacheKeys(node.client, this.budgets, dbSize)), dbSize };
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
      replica ? [] : sampleLmcacheKeys(node.client, downsampleSeries(matchedKeys, this.sampleSize), ownsSlot),
      checkClients ? hasLmcacheGlideClient(node.client, node.client.getActiveDbIndex?.() ?? 0) : false,
    ]);
    return { ...rest, glide, nodeKey: node.connectionId ?? node.name, observation: { ...scan, matchedKeys, samples } };
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

  private async carriedDetection(connectionId: string): Promise<boolean> {
    const misses = (this.partialMisses.get(connectionId) ?? 0) + 1;
    this.partialMisses.set(connectionId, misses);
    if (misses >= PARTIAL_MISSES_BEFORE_CLEAR) return false;
    const [previous] = await this.storage.getKvCacheFootprintSnapshots({ connectionId, limit: 1 });
    return previous?.detected === true;
  }

  private partialMissesExhausted(connectionId: string): boolean {
    return (this.partialMisses.get(connectionId) ?? 0) >= PARTIAL_MISSES_BEFORE_CLEAR;
  }

  private rememberSampleKey(connectionId: string, readings: NodeReading[], keepsEarlier: boolean): void {
    const parsed = readings.flatMap((reading) => reading.observation.matchedKeys)[0];
    if (parsed) this.sampleKeys.set(connectionId, maskKey(parsed));
    else if (!keepsEarlier) this.sampleKeys.delete(connectionId);
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
