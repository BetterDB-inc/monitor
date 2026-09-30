import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import {
  StoragePort,
  KeyPatternSnapshot,
  HotKeyEntry,
  HotKeyQueryOptions,
} from '@app/common/interfaces/storage-port.interface';
import {
  MultiConnectionPoller,
  ConnectionContext,
} from '@app/common/services/multi-connection-poller';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { LicenseService } from '@proprietary/licenses/license.service';
import {
  ConnectionStatus,
  KeyAnalyticsResult,
  KeySizeDistribution,
  KEY_DETAILS_TOP_N,
  hasOwnKeyAnalytics,
  mergeKeySizeDistributions,
  parseKeySizeDistribution,
} from '@betterdb/shared';
import type { DatabasePort } from '@app/common/interfaces/database-port.interface';
import { rankCompositeKeys } from './composite-key-ranker';
import { CollectionPlan, collectionPlan, isScannable } from './key-analytics-plan';
import { buildPatternSnapshots, mergePatternSnapshots } from './key-pattern-snapshots';
import { randomUUID } from 'crypto';

// The collectors prune keyDetails mid-scan to the top KEY_DETAILS_TOP_N keys per
// ranking signal (LFU / idletime / cardinality). Because each per-key signal is
// fixed once measured, a key outside the top-N for a signal can never re-enter it
// as more keys are scanned, so the prune is lossless — as long as the downstream
// selection never asks for more than the collectors retained. Deriving these from
// the shared constant keeps that invariant true by construction.
const HOT_KEYS_TOP_N = KEY_DETAILS_TOP_N;
const LARGEST_KEYS_TOP_N = KEY_DETAILS_TOP_N;
// Composite (multi-dimensional) ranking reuses the same per-key data. Its two
// dimensions — hotness (LFU/idletime) and cardinality — are both signals the
// collector already retains a global top-N for, so a genuine composite (extreme
// on both) is always present in keyDetails; the per-dimension cutoff below shares
// that same top-N bound. (Memory is NOT globally retained and so is reported as
// context only, never as a ranking dimension — see composite-key-ranker.)
const COMPOSITE_TOP_N = KEY_DETAILS_TOP_N;
// Explicit storage fetch cap for ranked reads: adapters default a missing limit
// to 50, which would truncate multi-snapshot sets BEFORE the memory re-rank.
const LARGEST_KEYS_FETCH_CAP = 10_000;

const NO_KEY_SIZES: KeySizeDistribution = { databases: {}, available: false };

interface ScanNode {
  name: string;
  client: DatabasePort;
}

function dedupeByKeyMaxMemory(entries: HotKeyEntry[]): HotKeyEntry[] {
  const byKey = new Map<string, HotKeyEntry>();
  for (const entry of entries) {
    const existing = byKey.get(entry.keyName);
    if (existing === undefined || (entry.memoryBytes ?? 0) > (existing.memoryBytes ?? 0)) {
      byKey.set(entry.keyName, entry);
    }
  }
  return Array.from(byKey.values());
}

@Injectable()
export class KeyAnalyticsService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(KeyAnalyticsService.name);
  private isRunning = new Map<string, boolean>();

  private readonly sampleSize: number;
  private readonly scanBatchSize: number;
  private readonly intervalMs: number;

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly license: LicenseService,
  ) {
    super(connectionRegistry);
    this.sampleSize = parseInt(process.env.KEY_ANALYTICS_SAMPLE_SIZE || '10000', 10);
    this.scanBatchSize = parseInt(process.env.KEY_ANALYTICS_SCAN_BATCH_SIZE || '1000', 10);
    this.intervalMs = parseInt(process.env.KEY_ANALYTICS_INTERVAL_MS || '300000', 10);
  }

  protected getIntervalMs(): number {
    return this.intervalMs;
  }

  async onModuleInit() {
    if (!this.license.hasFeature('keyAnalytics')) {
      this.logger.log('Key Analytics requires Pro license - service disabled');
      return;
    }

    this.logger.log(
      `Key Analytics service initialized (sample: ${this.sampleSize}, interval: ${this.intervalMs}ms)`,
    );

    this.start();
    // Retention for key_pattern_snapshots and hot_key_stats is owned by the
    // shared sweeps (cloud DataRetentionService / self-hosted
    // LocalRetentionService via runRetentionSweep) — no service-local pruner.
    // The old private timer here never fired within 24h of a restart and did
    // not run at all when the feature was unlicensed.
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.isRunning.delete(connectionId);
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    return this.collect(ctx, false);
  }

  private planFor(connectionId: string): CollectionPlan {
    const connections = this.connectionRegistry.list();
    const connection = connections.find((candidate) => candidate.id === connectionId);
    return connection ? collectionPlan(connection, connections) : { kind: 'single' };
  }

  private hidesAnalytics(connectionId?: string): boolean {
    if (!connectionId) {
      return false;
    }
    const connection = this.connectionRegistry.list({ includeRetired: true }).find((candidate) => candidate.id === connectionId);
    return connection !== undefined && !hasOwnKeyAnalytics(connection.membership);
  }

  private clusterNodes(seed: ScanNode, members: ConnectionStatus[]): ScanNode[] {
    const nodes = [seed];
    for (const member of members) {
      try {
        nodes.push({ name: member.name, client: this.connectionRegistry.get(member.id) });
      } catch {
        this.logger.warn(`Key analytics skipped ${member.name}: the connection is no longer registered`);
      }
    }
    return nodes;
  }

  private async primaries(nodes: ScanNode[]): Promise<ScanNode[]> {
    const roles = await Promise.allSettled(nodes.map((node) => node.client.getRole()));
    return nodes.filter((node, index) => {
      const role = roles[index];
      if (role.status === 'rejected') {
        this.logger.warn(`Key analytics could not read the role of ${node.name}: ${role.reason instanceof Error ? role.reason.message : role.reason}`);
        return false;
      }
      return role.value.role === 'master';
    });
  }

  private async scan(ctx: ConnectionContext, plan: CollectionPlan, fullScan: boolean): Promise<KeyAnalyticsResult[]> {
    const options = { sampleSize: this.sampleSize, scanBatchSize: this.scanBatchSize, fullScan };
    if (plan.kind !== 'cluster') {
      return [await ctx.client.collectKeyAnalytics(options)];
    }
    const nodes = await this.primaries(this.clusterNodes({ name: ctx.connectionName, client: ctx.client }, plan.members));
    if (nodes.length === 0) {
      throw new Error(`No reachable primary found for ${ctx.connectionName}`);
    }
    const scans = await Promise.allSettled(nodes.map((node) => node.client.collectKeyAnalytics(options)));
    const results: KeyAnalyticsResult[] = [];
    const failures: unknown[] = [];
    scans.forEach((scanResult, index) => {
      if (scanResult.status === 'fulfilled') {
        results.push(scanResult.value);
        return;
      }
      failures.push(scanResult.reason);
      this.logger.warn(
        `Key analytics scan failed on ${nodes[index].name}: ${scanResult.reason instanceof Error ? scanResult.reason.message : scanResult.reason}`,
      );
    });
    if (results.length === 0 && failures.length > 0) {
      throw failures[0];
    }
    return results;
  }

  private async collect(ctx: ConnectionContext, fullScan: boolean): Promise<void> {
    const plan = this.planFor(ctx.connectionId);
    if (plan.kind === 'skip') {
      return;
    }

    if (this.isRunning.get(ctx.connectionId)) {
      this.logger.debug(
        `Key analytics collection already running for ${ctx.connectionName}, skipping`,
      );
      return;
    }

    this.isRunning.set(ctx.connectionId, true);
    const startTime = Date.now();

    try {
      const results = (await this.scan(ctx, plan, fullScan)).filter((result) => result.dbSize > 0);

      if (results.length === 0) {
        this.logger.log('No keys found in database, skipping analytics');
        return;
      }

      const dbSize = results.reduce((total, result) => total + result.dbSize, 0);
      const scanned = results.reduce((total, result) => total + result.scanned, 0);
      const timestamp = Date.now();
      const snapshots = mergePatternSnapshots(results.map((result) => buildPatternSnapshots(result, timestamp)));
      const keyDetails = results.flatMap((result) => result.keyDetails ?? []);

      await this.storage.saveKeyPatternSnapshots(snapshots, ctx.connectionId);

      // Collect hot keys from per-key pipeline data
      if (keyDetails.length > 0) {
        const capturedAt = Date.now();
        const lfuKeys: typeof keyDetails = [];
        const idletimeKeys: typeof keyDetails = [];

        for (const kd of keyDetails) {
          if (kd.freqScore !== null) {
            lfuKeys.push(kd);
          } else if (kd.idleSeconds !== null) {
            idletimeKeys.push(kd);
          }
        }

        // LFU: descending by freqScore
        lfuKeys.sort((a, b) => (b.freqScore ?? 0) - (a.freqScore ?? 0));
        // IDLETIME: ascending by idleSeconds (lower = more recently accessed)
        idletimeKeys.sort((a, b) => (a.idleSeconds ?? 0) - (b.idleSeconds ?? 0));

        // LFU keys rank above all IDLETIME keys
        const ranked = [...lfuKeys, ...idletimeKeys].slice(0, HOT_KEYS_TOP_N);

        const hotKeys: HotKeyEntry[] = ranked.map((kd, idx) => {
          const isLfu = kd.freqScore !== null;
          return {
            id: randomUUID(),
            keyName: kd.keyName,
            connectionId: ctx.connectionId,
            capturedAt,
            signalType: isLfu ? ('lfu' as const) : ('idletime' as const),
            freqScore: isLfu ? (kd.freqScore ?? undefined) : undefined,
            idleSeconds: !isLfu ? (kd.idleSeconds ?? undefined) : undefined,
            memoryBytes: kd.memoryBytes ?? undefined,
            ttl: kd.ttl ?? undefined,
            rank: idx + 1,
          };
        });

        // Largest keys (valkey #1827): rank by cardinality (element count / byte length).
        const largestKeys: HotKeyEntry[] = keyDetails
          .filter((kd) => kd.cardinality !== null)
          .sort((a, b) => (b.cardinality ?? 0) - (a.cardinality ?? 0))
          .slice(0, LARGEST_KEYS_TOP_N)
          .map((kd, idx) => ({
            id: randomUUID(),
            keyName: kd.keyName,
            connectionId: ctx.connectionId,
            capturedAt,
            signalType: 'cardinality' as const,
            cardinality: kd.cardinality ?? undefined,
            keyType: kd.keyType ?? undefined,
            memoryBytes: kd.memoryBytes ?? undefined,
            ttl: kd.ttl ?? undefined,
            rank: idx + 1,
          }));

        // Composite / multi-dimensional keys (valkey #4189): keys that are extreme
        // on more than one dimension at once — the "hot big key" that the single
        // signal lists above each miss. Derived from the same per-key data, so no
        // extra scanning; only keys placing in >= 2 dimensions are emitted.
        const compositeKeys: HotKeyEntry[] = rankCompositeKeys(
          keyDetails.map((kd) => ({
            keyName: kd.keyName,
            keyType: kd.keyType,
            freqScore: kd.freqScore,
            idleSeconds: kd.idleSeconds,
            memoryBytes: kd.memoryBytes,
            cardinality: kd.cardinality,
            ttl: kd.ttl,
          })),
          COMPOSITE_TOP_N,
        )
          .slice(0, COMPOSITE_TOP_N)
          .map((ck, idx) => ({
            id: randomUUID(),
            keyName: ck.keyName,
            connectionId: ctx.connectionId,
            capturedAt,
            signalType: 'composite' as const,
            freqScore: ck.freqScore ?? undefined,
            idleSeconds: ck.idleSeconds ?? undefined,
            memoryBytes: ck.memoryBytes ?? undefined,
            cardinality: ck.cardinality ?? undefined,
            keyType: ck.keyType ?? undefined,
            ttl: ck.ttl ?? undefined,
            rank: idx + 1,
          }));

        // Persist all three signal groups in ONE atomic saveHotKeys call so a
        // reader never sees a half-written collection. If hot/largest rows landed
        // first under this capturedAt while composites were still pending, the
        // composite freshness guard (getCompositeKeys) would read the newer
        // non-composite rows, conclude the scan produced no composites, and
        // return empty even though composites were about to be written. Writing
        // them together (saveHotKeys wraps the batch in a transaction) means a
        // capturedAt is either fully visible with its composites or not at all.
        const hotKeyRows = [...hotKeys, ...largestKeys, ...compositeKeys];
        if (hotKeyRows.length > 0) {
          await this.storage.saveHotKeys(hotKeyRows, ctx.connectionId);
        }
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `Key Analytics (${ctx.connectionName}): ${fullScan ? 'deep-scanned' : 'sampled'} ${scanned}/${dbSize} keys (${(Math.min(1, scanned / dbSize) * 100).toFixed(1)}%)` +
          `${results.length > 1 ? ` across ${results.length} primaries` : ''}, found ${snapshots.length} patterns in ${duration}ms`,
      );
    } catch (error) {
      this.logger.error(`Error collecting key analytics for ${ctx.connectionName}:`, error);
      throw error;
    } finally {
      this.isRunning.set(ctx.connectionId, false);
    }
  }

  async getSummary(startTime?: number, endTime?: number, connectionId?: string) {
    if (this.hidesAnalytics(connectionId)) {
      return null;
    }
    return this.storage.getKeyAnalyticsSummary(startTime, endTime, connectionId);
  }

  async getPatternSnapshots(options?: {
    pattern?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
    connectionId?: string;
  }) {
    if (this.hidesAnalytics(options?.connectionId)) {
      return [];
    }
    return this.storage.getKeyPatternSnapshots(options);
  }

  async getPatternTrends(
    pattern: string,
    startTime: number,
    endTime: number,
    connectionId?: string,
  ) {
    if (this.hidesAnalytics(connectionId)) {
      return [];
    }
    return this.storage.getKeyPatternTrends(pattern, startTime, endTime, connectionId);
  }

  async getHotKeys(options?: HotKeyQueryOptions): Promise<HotKeyEntry[]> {
    if (this.hidesAnalytics(options?.connectionId)) {
      return [];
    }
    return this.storage.getHotKeys(options);
  }

  /** Top-N largest keys ranked by memory usage among tracked (cardinality-signal) entries. */
  async getLargestKeys(options?: HotKeyQueryOptions): Promise<HotKeyEntry[]> {
    if (this.hidesAnalytics(options?.connectionId)) {
      return [];
    }
    const { limit, ...rest } = options ?? {};
    const entries = await this.storage.getHotKeys({
      ...rest,
      signalTypes: ['cardinality'],
      limit: LARGEST_KEYS_FETCH_CAP,
    });
    // latest/oldest pin a single snapshot; anything else can span snapshots,
    // where the same key appears once per snapshot and would dominate the
    // ranking — keep only each key's largest observation.
    const singleSnapshot = rest.latest === true || rest.oldest === true;
    const candidates = singleSnapshot ? entries : dedupeByKeyMaxMemory(entries);
    const ranked = [...candidates].sort((a, b) => {
      return (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0);
    });
    const limited = limit === undefined ? ranked : ranked.slice(0, limit);
    return limited.map((entry, index) => {
      return { ...entry, rank: index + 1 };
    });
  }

  /**
   * Top-N composite ("hot big key") keys — extreme on both the hotness and
   * cardinality dimensions at once (valkey #4189).
   *
   * Note the two "big" surfaces deliberately measure different things:
   * getLargestKeys ranks by memoryBytes (re-ranked from a single MEMORY USAGE
   * pass), whereas composite "big" is cardinality. Memory is not globally
   * retained by the collectors, so a memory top-N over the pruned pool would be
   * biased (see COMPOSITE_TOP_N above); cardinality is. A consequence is that a
   * hot, memory-huge but low-cardinality value can top getLargestKeys yet never
   * qualify as composite. Unifying the two on a memory-aware "big" is Phase-B
   * work gated on the collectors retaining a global memory top-N.
   */
  async getCompositeKeys(options?: HotKeyQueryOptions): Promise<HotKeyEntry[]> {
    if (this.hidesAnalytics(options?.connectionId)) {
      return [];
    }
    const composite = await this.storage.getHotKeys({ ...options, signalTypes: ['composite'] });

    // Unlike the other lists, a scan can legitimately find zero composite keys
    // (nothing hot AND big) even on a full database. When that happens no
    // 'composite' row is written, so a `latest` query — MAX(captured_at) over
    // composite rows — would pin the previous non-empty batch and keep serving
    // keys that are no longer composite. Every signal in one collection shares a
    // capturedAt, so if the connection's newest row (any signal) is newer than
    // the newest composite row, the latest scan produced no composites: return
    // empty.
    //
    // This comparison is only sound *per connection*: a shared capturedAt holds
    // within one connection, not across connections. For an unscoped query
    // (connectionId omitted), a later empty scan on connection A would otherwise
    // wrongly suppress connection B's still-valid composites — so the guard is
    // limited to connection-scoped latest views (and never to explicit ranges).
    if (
      options?.connectionId &&
      options.latest &&
      !options.startTime &&
      !options.endTime &&
      composite.length > 0
    ) {
      const newestAny = await this.storage.getHotKeys({
        connectionId: options.connectionId,
        signalTypes: ['lfu', 'idletime', 'cardinality', 'composite'],
        latest: true,
        limit: 1,
      });
      const latestCollectionAt = newestAny[0]?.capturedAt;
      if (latestCollectionAt !== undefined && composite[0].capturedAt < latestCollectionAt) {
        return [];
      }
    }

    return composite;
  }

  async pruneOldSnapshots(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    return this.storage.pruneOldKeyPatternSnapshots(cutoffTimestamp, connectionId);
  }

  /**
   * Manually trigger key analytics collection for all connected databases.
   * Returns a promise that resolves when collection is complete for all connections.
   */
  async triggerCollection(fullScan = false): Promise<void> {
    const connections = this.connectionRegistry.list();
    const connectedConnections = connections.filter(
      (conn) => isScannable(conn) && !this.isSentinelConnection(conn.id) && collectionPlan(conn, connections).kind !== 'skip',
    );

    if (connectedConnections.length === 0) {
      this.logger.warn('No connected databases found for key analytics collection');
      return;
    }

    this.logger.log(
      `Manually triggering ${fullScan ? 'deep-scan ' : ''}key analytics collection for ${connectedConnections.length} connection(s)`,
    );

    const promises = connectedConnections.map(async (conn) => {
      try {
        const client = this.connectionRegistry.get(conn.id);
        await this.collect(
          {
            connectionId: conn.id,
            connectionName: conn.name,
            client,
            host: conn.host,
            port: conn.port,
          },
          fullScan,
        );
      } catch (error) {
        this.logger.warn(
          `Manual collection failed for ${conn.name}: ${error instanceof Error ? error.message : error}`,
        );
      }
    });

    await Promise.allSettled(promises);
  }

  /**
   * Whole-keyspace size distribution via `INFO keysizes` (server-maintained,
   * no key scanning). Returns `available: false` if the server lacks the section.
   */
  async getKeySizes(connectionId?: string): Promise<KeySizeDistribution> {
    const connections = this.connectionRegistry.list();
    const target = connectionId
      ? connections.find((conn) => conn.id === connectionId)
      : connections.find((conn) => isScannable(conn) && hasOwnKeyAnalytics(conn.membership));
    const targetId = connectionId ?? target?.id;
    if (!targetId || this.hidesAnalytics(targetId)) {
      return NO_KEY_SIZES;
    }

    const client = this.connectionRegistry.get(targetId);
    if (!client) {
      return NO_KEY_SIZES;
    }

    const plan: CollectionPlan = target ? collectionPlan(target, connections) : { kind: 'single' };
    if (plan.kind !== 'cluster') {
      return this.keySizesOf(client);
    }

    const nodes = await this.primaries(this.clusterNodes({ name: target?.name ?? targetId, client }, plan.members));
    return mergeKeySizeDistributions(await Promise.all(nodes.map((node) => this.keySizesOf(node.client))));
  }

  private async keySizesOf(client: DatabasePort): Promise<KeySizeDistribution> {
    try {
      const raw = (await client.call('INFO', ['keysizes'])) as string;
      return parseKeySizeDistribution(raw ?? '');
    } catch {
      // Servers without the keysizes section may reject the argument outright
      // (e.g. an ERR reply) rather than returning an empty string. Treat any
      // failure as "section unavailable" so the tab shows its empty state.
      return NO_KEY_SIZES;
    }
  }
}
