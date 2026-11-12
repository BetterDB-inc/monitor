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
  KeyAnalyticsResult,
  KeyDetail,
  KeySizeDistribution,
  KEY_DETAILS_TOP_N,
  KEY_ANALYTICS_FETCH_CAP,
  compareHotness,
  dbScopedIdentity,
  hasOwnKeyAnalytics,
  mergeKeySizeDistributions,
  parseKeySizeDistribution,
  rankHotKeys,
} from '@betterdb/shared';
import type { DatabasePort } from '@app/common/interfaces/database-port.interface';
import { rankCompositeKeys } from './composite-key-ranker';
import { CollectionPlan, collectionPlan, isScannable, planForConnection } from './key-analytics-plan';
import { buildPatternSnapshots, mergePatternSnapshots } from './key-pattern-snapshots';
import { clusterScanNodes, primaryScanNodes } from './scan-nodes';
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

const NO_KEY_SIZES: KeySizeDistribution = { databases: {}, available: false };

function dedupeByKeyMaxMemory(entries: HotKeyEntry[]): HotKeyEntry[] {
  const byKey = new Map<string, HotKeyEntry>();
  for (const entry of entries) {
    // The same key name can exist in several logical databases — those are
    // distinct keys, so the identity includes the database index.
    const identity = dbScopedIdentity(entry.db, entry.keyName);
    const existing = byKey.get(identity);
    if (existing === undefined || (entry.memoryBytes ?? 0) > (existing.memoryBytes ?? 0)) {
      byKey.set(identity, entry);
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

  onModuleInit() {
    // hasFeature() reports the community tier until the background entitlement
    // validation kicked off by LicenseService resolves, so a boot-time check
    // without waiting disabled the collector on every start of a licensed
    // instance. Wait for the verdict the way the license guard does — but off
    // the module-init path: NestJS awaits init hooks sequentially before
    // app.listen, so awaiting here stalled every boot (including keyless
    // community instances) by up to the 5s validation timeout. Deferring
    // start() until the verdict keeps the immediate first tick accurate;
    // pollConnection re-checks per tick, so an entitlement that only lands
    // later (boot-time network failure, heartbeat re-validation) enables
    // collection without a restart, and a lapsed one stops it.
    // ensureValidated never rejects (it resolves community on timeout).
    this.startAfter(this.license.ensureValidated().finally(() => {
      if (this.license.hasFeature('keyAnalytics')) {
        this.logger.log(
          `Key Analytics service initialized (sample: ${this.sampleSize}, interval: ${this.intervalMs}ms)`,
        );
      } else {
        this.logger.log('Key Analytics requires Pro license - collection idle until entitled');
      }
    }));
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
    if (!this.license.hasFeature('keyAnalytics')) {
      return;
    }
    return this.collect(ctx, false);
  }

  private hidesAnalytics(connectionId?: string): boolean {
    if (!connectionId) {
      return false;
    }
    const connection = this.connectionRegistry.list({ includeRetired: true }).find((candidate) => candidate.id === connectionId);
    return connection !== undefined && !hasOwnKeyAnalytics(connection.membership);
  }

  private async scan(ctx: ConnectionContext, plan: CollectionPlan, fullScan: boolean): Promise<KeyAnalyticsResult[]> {
    const options = { sampleSize: this.sampleSize, scanBatchSize: this.scanBatchSize, fullScan };
    if (plan.kind !== 'cluster') {
      return await ctx.client.collectKeyAnalytics(options);
    }
    const nodes = await primaryScanNodes(clusterScanNodes(this.connectionRegistry, { name: ctx.connectionName, client: ctx.client }, plan.members, this.logger, 'Key analytics'), this.logger, 'Key analytics');
    if (nodes.length === 0) {
      throw new Error(`No reachable primary found for ${ctx.connectionName}`);
    }
    const scans = await Promise.allSettled(nodes.map((node) => node.client.collectKeyAnalytics(options)));
    const results: KeyAnalyticsResult[] = [];
    const failures: unknown[] = [];
    scans.forEach((scanResult, index) => {
      if (scanResult.status === 'fulfilled') {
        results.push(...scanResult.value);
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
    const plan = planForConnection(this.connectionRegistry, ctx.connectionId);
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
        this.logger.log('No keys found in any logical database, skipping analytics');
        return;
      }

      const dbSize = results.reduce((total, result) => total + result.dbSize, 0);
      const scanned = results.reduce((total, result) => total + result.scanned, 0);
      const timestamp = Date.now();
      const snapshots = mergePatternSnapshots(results.map((result) => buildPatternSnapshots(result, timestamp)));
      await this.storage.saveKeyPatternSnapshots(snapshots, ctx.connectionId);

      // Rank hot/largest/composite keys PER logical database rather than as a
      // single global top-N across the whole instance: a database whose keys
      // are crowded out by a busier sibling still gets its own ranked lists,
      // and each db's ranks stay contiguous (1..N) for the per-db UI views. One
      // capturedAt is shared across all dbs so the composite freshness guard
      // (getCompositeKeys) still sees a single atomic collection. Results from
      // several cluster primaries share db 0, so they are merged into one group
      // and ranked together — only distinct logical databases rank separately.
      const capturedAt = Date.now();
      const keyDetailsByDb = new Map<number, KeyDetail[]>();
      for (const result of results) {
        const db = result.db ?? 0;
        const group = keyDetailsByDb.get(db);
        if (group) {
          group.push(...(result.keyDetails ?? []));
        } else {
          keyDetailsByDb.set(db, [...(result.keyDetails ?? [])]);
        }
      }
      const hotKeyRows: HotKeyEntry[] = [];
      for (const [db, kds] of keyDetailsByDb) {
        if (kds.length === 0) continue;
        hotKeyRows.push(...this.buildHotKeyRows(kds, db, capturedAt, ctx.connectionId));
      }

      // Persist all signal groups in ONE atomic saveHotKeys call so a reader
      // never sees a half-written collection. If hot/largest rows landed first
      // under this capturedAt while composites were still pending, the composite
      // freshness guard (getCompositeKeys) would read the newer non-composite
      // rows, conclude the scan produced no composites, and return empty even
      // though composites were about to be written. Writing them together
      // (saveHotKeys wraps the batch in a transaction) means a capturedAt is
      // either fully visible with its composites or not at all.
      if (hotKeyRows.length > 0) {
        await this.storage.saveHotKeys(hotKeyRows, ctx.connectionId);
      }

      const duration = Date.now() - startTime;
      const scannedDbs = new Set(results.map((result) => result.db ?? 0));
      const spread =
        results.length > 1
          ? ` across ${results.length} ${scannedDbs.size > 1 ? `logical database scans (db ${[...scannedDbs].sort((a, b) => a - b).join(', db ')})` : 'primaries'}`
          : '';
      this.logger.log(
        `Key Analytics (${ctx.connectionName}): ${fullScan ? 'deep-scanned' : 'sampled'} ${scanned}/${dbSize} keys (${(Math.min(1, scanned / dbSize) * 100).toFixed(1)}%)` +
          `${spread}, found ${snapshots.length} patterns in ${duration}ms`,
      );
    } catch (error) {
      this.logger.error(`Error collecting key analytics for ${ctx.connectionName}:`, error);
      throw error;
    } finally {
      this.isRunning.set(ctx.connectionId, false);
    }
  }

  /**
   * Build the hot / largest / composite hot-key rows for ONE logical database's
   * per-key sample. Ranked and capped per database so a quiet db is not crowded
   * out of the instance-wide top-N by a busier sibling, with ranks contiguous
   * within the db.
   */
  private buildHotKeyRows(
    keyDetails: KeyDetail[],
    db: number,
    capturedAt: number,
    connectionId: string,
  ): HotKeyEntry[] {
    // Access-signal keys (LFU frequency or idle time present), ranked by the
    // shared hotness policy — LFU above idletime, then freqScore desc / idle
    // asc. compareHotness is the single definition of this policy, reused by the
    // read-time global re-rank (rankHotKeys) so collection and read never drift.
    const ranked = keyDetails
      .filter((kd) => kd.freqScore !== null || kd.idleSeconds !== null)
      .sort(compareHotness)
      .slice(0, HOT_KEYS_TOP_N);
    const hotKeys: HotKeyEntry[] = ranked.map((kd, idx) => {
      const isLfu = kd.freqScore !== null;
      return {
        id: randomUUID(),
        keyName: kd.keyName,
        connectionId,
        capturedAt,
        signalType: isLfu ? ('lfu' as const) : ('idletime' as const),
        freqScore: isLfu ? (kd.freqScore ?? undefined) : undefined,
        idleSeconds: !isLfu ? (kd.idleSeconds ?? undefined) : undefined,
        memoryBytes: kd.memoryBytes ?? undefined,
        ttl: kd.ttl ?? undefined,
        rank: idx + 1,
        db,
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
        connectionId,
        capturedAt,
        signalType: 'cardinality' as const,
        cardinality: kd.cardinality ?? undefined,
        keyType: kd.keyType ?? undefined,
        memoryBytes: kd.memoryBytes ?? undefined,
        ttl: kd.ttl ?? undefined,
        rank: idx + 1,
        db,
      }));

    // Composite / multi-dimensional keys (valkey #4189): keys that are extreme
    // on more than one dimension at once — the "hot big key" that the single
    // signal lists above each miss. Derived from the same per-key data, so no
    // extra scanning; only keys placing in >= 2 dimensions are emitted.
    const compositeKeys: HotKeyEntry[] = rankCompositeKeys(
      keyDetails.map((kd) => ({
        keyName: kd.keyName,
        keyType: kd.keyType,
        db,
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
        connectionId,
        capturedAt,
        signalType: 'composite' as const,
        freqScore: ck.freqScore ?? undefined,
        idleSeconds: ck.idleSeconds ?? undefined,
        memoryBytes: ck.memoryBytes ?? undefined,
        cardinality: ck.cardinality ?? undefined,
        keyType: ck.keyType ?? undefined,
        ttl: ck.ttl ?? undefined,
        rank: idx + 1,
        db,
      }));

    return [...hotKeys, ...largestKeys, ...compositeKeys];
  }

  async getSummary(startTime?: number, endTime?: number, connectionId?: string, db?: number) {
    if (this.hidesAnalytics(connectionId)) {
      return null;
    }
    return this.storage.getKeyAnalyticsSummary(startTime, endTime, connectionId, db);
  }

  async getPatternSnapshots(options?: {
    pattern?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
    connectionId?: string;
    db?: number;
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
    db?: number,
  ) {
    if (this.hidesAnalytics(connectionId)) {
      return [];
    }
    return this.storage.getKeyPatternTrends(pattern, startTime, endTime, connectionId, db);
  }

  /** Distinct logical database indexes with stored analytics for the connection. */
  async getDatabases(connectionId?: string): Promise<number[]> {
    if (this.hidesAnalytics(connectionId)) {
      return [];
    }
    return this.storage.getKeyAnalyticsDatabases(connectionId);
  }

  async getHotKeys(options?: HotKeyQueryOptions): Promise<HotKeyEntry[]> {
    if (this.hidesAnalytics(options?.connectionId)) {
      return [];
    }
    const { limit, ...rest } = options ?? {};
    // Hot-key ranks are stored PER logical database (buildHotKeyRows numbers
    // 1..N within each db), so an unfiltered multi-db read comes back
    // interleaved (rank 1 of every db, then rank 2, ...) and a storage-level
    // limit would truncate by per-db rank — dropping a database's genuinely
    // hotter keys in favor of another's low-ranked ones. Fetch the whole
    // capture (bounded by the fetch cap), then re-rank globally and renumber
    // via the shared helper — the same ranking the MCP hot-keys tool applies —
    // before slicing to the caller's limit. Mirrors getLargestKeys.
    const entries = await this.storage.getHotKeys({
      ...rest,
      limit: KEY_ANALYTICS_FETCH_CAP,
    });
    const singleSnapshot = rest.latest === true || rest.oldest === true;
    // Default to the collector's per-db top-N (50) when a direct service caller
    // omits a limit, rather than returning the whole fetch cap.
    return rankHotKeys(entries, { limit: limit ?? HOT_KEYS_TOP_N, singleSnapshot });
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
      limit: KEY_ANALYTICS_FETCH_CAP,
    });
    // latest/oldest pin a single snapshot; anything else can span snapshots,
    // where the same key appears once per snapshot and would dominate the
    // ranking — keep only each key's largest observation.
    const singleSnapshot = rest.latest === true || rest.oldest === true;
    const candidates = singleSnapshot ? entries : dedupeByKeyMaxMemory(entries);
    const ranked = [...candidates].sort((a, b) => {
      return (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0);
    });
    // Default to the collector's per-db top-N (50) when a direct service caller
    // omits a limit, rather than returning the whole fetch cap.
    const limited = ranked.slice(0, Math.max(0, limit ?? LARGEST_KEYS_TOP_N));
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
    const { limit, ...rest } = options ?? {};
    const connectionId = rest.connectionId;

    // Connection-scoped latest/oldest reads: issue one db-pinned query per
    // database so storage scopes MAX/MIN(captured_at) to that database. A single
    // global `latest`/`oldest` pin would (latest) drop a database whose latest
    // composite capture is older than a sibling's (e.g. a partial scan where
    // only the sibling was rescanned), and (oldest) select the minimum within
    // the newest CAP-truncated window rather than each database's true oldest
    // capture. A db-filtered read is a single pinned query (and keeps its
    // freshness guard); range reads fall through to one windowed fetch.
    const perDbPinned =
      connectionId !== undefined &&
      (rest.latest === true || rest.oldest === true) &&
      !rest.startTime &&
      !rest.endTime;

    let rows: HotKeyEntry[];
    if (perDbPinned) {
      // Enumerate from hot_key_stats (where composites live), NOT
      // key_pattern_snapshots: the two can diverge (e.g. pattern-only retention
      // pruning), which would otherwise skip a database that still has stored
      // composites but no pattern rows.
      const dbs =
        rest.db !== undefined
          ? [rest.db]
          : await this.storage.getHotKeyDatabases(connectionId);
      const perDb = await Promise.all(
        dbs.map(async (db) => {
          const composites = await this.storage.getHotKeys({
            ...rest,
            db,
            signalTypes: ['composite'],
            limit: KEY_ANALYTICS_FETCH_CAP,
          });
          if (composites.length === 0) {
            return [];
          }
          // Freshness guard (latest only): a scan can legitimately find zero
          // composites (nothing hot AND big), writing no 'composite' row, so
          // drop this database's composites when its newest ANY-signal capture
          // is newer than its newest composite — that scan produced none.
          if (rest.latest) {
            const newestAny = await this.storage.getHotKeys({
              connectionId,
              db,
              signalTypes: ['lfu', 'idletime', 'cardinality', 'composite'],
              latest: true,
              limit: 1,
            });
            const latestCollectionAt = newestAny[0]?.capturedAt;
            if (
              latestCollectionAt !== undefined &&
              composites[0].capturedAt < latestCollectionAt
            ) {
              return [];
            }
          }
          return composites;
        }),
      );
      rows = perDb.flat();
    } else {
      rows = await this.storage.getHotKeys({
        ...rest,
        signalTypes: ['composite'],
        limit: KEY_ANALYTICS_FETCH_CAP,
      });
    }

    // Collapse a (db, key) that recurs across snapshots to its most recent
    // observation (storage returns captured_at DESC, so the first seen wins), so
    // a multi-snapshot range read does not spend the limit on duplicate rows.
    const seen = new Set<string>();
    const deduped: HotKeyEntry[] = [];
    for (const row of rows) {
      const identity = dbScopedIdentity(row.db, row.keyName);
      if (seen.has(identity)) continue;
      seen.add(identity);
      deduped.push(row);
    }

    // Ordering. A single database's stored rank IS its composite order, so keep
    // it. Across databases the stored per-db rank is not comparable (composite
    // scores are normalized per database), so re-rank the merged set through the
    // composite scorer with one global dimension-max — the full size as the
    // per-dimension cutoff, so a genuine composite is never re-filtered out —
    // yielding a cross-db comparable order instead of an arbitrary interleave.
    let ordered = deduped;
    if (rest.db === undefined && deduped.length > 1) {
      const positionByKey = new Map<string, number>();
      rankCompositeKeys(
        deduped.map((row) => ({
          keyName: row.keyName,
          keyType: row.keyType ?? null,
          db: row.db,
          freqScore: row.freqScore ?? null,
          idleSeconds: row.idleSeconds ?? null,
          memoryBytes: row.memoryBytes ?? null,
          cardinality: row.cardinality ?? null,
          ttl: row.ttl ?? null,
        })),
        deduped.length,
      ).forEach((ranked, index) => {
        positionByKey.set(dbScopedIdentity(ranked.db, ranked.keyName), index);
      });
      ordered = deduped
        .filter((row) => positionByKey.has(dbScopedIdentity(row.db, row.keyName)))
        .sort(
          (a, b) =>
            (positionByKey.get(dbScopedIdentity(a.db, a.keyName)) ?? 0) -
            (positionByKey.get(dbScopedIdentity(b.db, b.keyName)) ?? 0),
        );
    }

    // Default to the collector's per-db top-N (50) when a direct service caller
    // omits a limit, rather than returning the whole fetch cap.
    const limited = ordered.slice(0, Math.max(0, limit ?? COMPOSITE_TOP_N));
    return limited.map((entry, index) => ({ ...entry, rank: index + 1 }));
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

    const nodes = await primaryScanNodes(clusterScanNodes(this.connectionRegistry, { name: target?.name ?? targetId, client }, plan.members, this.logger, 'Key analytics'), this.logger, 'Key analytics');
    return mergeKeySizeDistributions(await Promise.all(nodes.map((node) => this.keySizesOf(node.client))));
  }

  private async keySizesOf(client: DatabasePort): Promise<KeySizeDistribution> {
    try {
      const raw = (await client.call('INFO', ['keysizes'])) as string;
      return parseKeySizeDistribution(raw ?? '');
    } catch {
      // Some managed servers reject the argument outright (NOPERM / "command is
      // not available") rather than returning an empty string. Treat any failure
      // as "section unavailable". A supported server with an empty keyspace is
      // handled by the parser instead (header present -> available:true), so this
      // path no longer conflates empty keyspaces with unsupported servers.
      return NO_KEY_SIZES;
    }
  }
}
