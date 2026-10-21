import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CLIENT_ANALYTICS_ROLLUP_BUCKET_MS,
  ClientAnalyticsRollup,
  ClientAnalyticsStats,
  clientRollupBucketStart,
} from '@betterdb/shared';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { ConnectionContext, MultiConnectionPoller } from '../common/services/multi-connection-poller';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { SettingsService } from '../settings/settings.service';
import { foldGroupsIntoRollups, mergeRollupsIntoStats } from './client-rollup-math';
import { QueryBudget, readPositiveNumber } from './query-budget';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** Aggregator cadence: how often new snapshots are folded and the latest stats refreshed. */
export const AGGREGATE_INTERVAL_MS = 15_000;
/** Span of raw history one incremental or backfill step reads; a whole number of buckets. */
export const BACKFILL_CHUNK_MS = HOUR_MS;
/** Incremental and backfill chunks processed per connection on each run. */
export const BACKFILL_CHUNKS_PER_RUN = 4;
/** Cold-start lookback cap: older history is filled by the backfill. */
const COLD_START_LOOKBACK_MAX_MS = HOUR_MS;
/**
 * An empty incremental chunk only moves the scan cursor past itself once it is
 * this far in the past; nearer the present the snapshot writer may still be
 * committing the batch it captured, so the cursor stays at the chunk's start
 * (or the watermark, if newer) and the chunk is re-read on the next run.
 */
const EMPTY_CHUNK_SETTLE_MS = 5 * 60_000;
const RETENTION_INTERVAL_MS = HOUR_MS;
/** Minimum gap between warnings that the backfill is still waiting for the snapshot index. */
const INDEX_WAIT_WARN_INTERVAL_MS = HOUR_MS;

/** Test-only DI token: overrides the fixed cadence and chunking constants. Never bound in production. */
export const CLIENT_ANALYTICS_ROLLUP_TUNING = Symbol('CLIENT_ANALYTICS_ROLLUP_TUNING');

export interface ClientAnalyticsRollupTuning {
  aggregateIntervalMs: number;
  backfillChunkMs: number;
  backfillChunksPerRun: number;
}

export interface ClientAnalyticsRollupConfig extends ClientAnalyticsRollupTuning {
  windowMs: number;
  rollupRetentionMs: number;
  /** null keeps raw snapshots forever. */
  rawRetentionMs: number | null;
}

/** A headline peak: the largest batch and when it was captured. */
interface PeakPoint {
  peak: number;
  capturedAt: number;
}

interface ConnectionRollupState {
  /**
   * Newest captured_at folded into the rollups. Null only for a passive state
   * (created while CLIENT LIST is unavailable, before any fold): it keeps the
   * window recompute and retention running, and is initialised from storage
   * once the capability returns.
   */
  watermark: number | null;
  /**
   * Lower bound of the next incremental read: the watermark, or past it when
   * settled empty chunks were skipped or jumped over (at most the start of the
   * newest chunk).
   */
  scanCursor: number | null;
  latest: ClientAnalyticsStats | null;
  computedAt: number;
  lastWindowStartBucket: number | null;
  backfillCursor: number | null;
  /** Bucket the cold-start lookback began at; the backfill starts here when no rollup exists yet. */
  coldStartFloor: number | null;
  backfillTarget: number | null;
  backfillDone: boolean;
  /**
   * Nothing to backfill from yet (no raw rows, or no rollup floor): the
   * backfill stays idle until the incremental step folds something, instead
   * of re-querying the bounds every run.
   */
  backfillWaitingForData: boolean;
  backfillStartedAt: number;
  backfillRowsFolded: number;
  lastRetentionAt: number;
  /**
   * Peak over the whole rollup retention (bucket_start >= the horizon), kept
   * in memory instead of re-queried on every recompute: read from storage
   * when the state is first polled, after each rollup prune, and when the
   * horizon passes the peak's bucket; raised in between from the rows each
   * fold writes. Null with no rollup in the retention.
   */
  retentionPeak: PeakPoint | null;
  /** False until retentionPeak has been read from storage. */
  retentionPeakLoaded: boolean;
  /** The window merge's own peak, kept so a new retentionPeak can be re-applied without re-reading the window. */
  windowPeak: PeakPoint | null;
}

export function readClientAnalyticsRollupConfig(
  configService?: ConfigService,
  tuning: Partial<ClientAnalyticsRollupTuning> = {},
): ClientAnalyticsRollupConfig {
  const rawRetentionDays = Number(configService?.get('CLIENT_ANALYTICS_RAW_RETENTION_DAYS'));
  const chunk = tuning.backfillChunkMs ?? BACKFILL_CHUNK_MS;
  return {
    aggregateIntervalMs: tuning.aggregateIntervalMs ?? AGGREGATE_INTERVAL_MS,
    windowMs: readPositiveNumber(configService, 'CLIENT_ANALYTICS_WINDOW_MS', DAY_MS),
    rollupRetentionMs: readPositiveNumber(configService, 'CLIENT_ANALYTICS_ROLLUP_RETENTION_DAYS', 90) * DAY_MS,
    rawRetentionMs: Number.isFinite(rawRetentionDays) && rawRetentionDays > 0 ? rawRetentionDays * DAY_MS : null,
    // Whole buckets only, so every backfill chunk folds complete buckets.
    backfillChunkMs:
      Math.ceil(chunk / CLIENT_ANALYTICS_ROLLUP_BUCKET_MS) * CLIENT_ANALYTICS_ROLLUP_BUCKET_MS,
    backfillChunksPerRun: Math.max(1, Math.floor(tuning.backfillChunksPerRun ?? BACKFILL_CHUNKS_PER_RUN)),
  };
}

/**
 * Folds raw client_snapshots into 5-minute rollup rows in the background and
 * keeps the latest windowed ClientAnalyticsStats per connection in memory, so
 * neither the Prometheus scrape nor the UI aggregates over raw rows.
 *
 * Every raw read is bounded to one connection and at most one chunk of
 * captured_at; history older than the cold-start lookback is filled by a
 * backwards backfill once the (connection_id, captured_at) index is ready.
 */
@Injectable()
export class ClientAnalyticsRollupService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(ClientAnalyticsRollupService.name);
  readonly config: ClientAnalyticsRollupConfig;
  private readonly budget: QueryBudget;
  private readonly states = new Map<string, ConnectionRollupState>();
  /**
   * One token per connection whose state is being initialised (the watermark
   * read is awaited). onConnectionRemoved drops the token, so a state built
   * from a read that raced a removal is never installed.
   */
  private readonly pendingInit = new Map<string, symbol>();
  /** The index never becomes invalid once valid, so a true result holds for the process lifetime. */
  private snapshotIndexReady = false;
  /** When the index-wait warning was last logged (per process, not per connection). */
  private lastIndexWaitWarnAt: number | null = null;
  /** Memoised all-connection default-window stats; see getLatestStatsAllConnections. */
  private allConnectionsLatest: { stats: Promise<ClientAnalyticsStats>; computedAt: number } | null = null;

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    configService: ConfigService,
    private readonly runtimeCapabilityTracker: RuntimeCapabilityTracker,
    @Optional() @Inject(CLIENT_ANALYTICS_ROLLUP_TUNING) tuning?: Partial<ClientAnalyticsRollupTuning>,
    // Global module, so no import is needed; optional so tests and contexts
    // without settings fall back to the one-bucket current cutoff.
    @Optional() private readonly settingsService?: SettingsService,
  ) {
    super(connectionRegistry);
    this.config = readClientAnalyticsRollupConfig(configService, tuning ?? {});
    this.budget = QueryBudget.fromConfig(configService, this.logger);
  }

  onModuleInit(): void {
    this.start();
  }

  protected getIntervalMs(): number {
    return this.config.aggregateIntervalMs;
  }

  protected pollsSentinels(): boolean {
    return true;
  }

  protected skipUnchangedSamples(): boolean {
    // The aggregator reads storage, not the connection, so the client's
    // sample version says nothing about whether new snapshots exist.
    return false;
  }

  /**
   * Latest stats over the configured window, or null before the aggregator's
   * first run for the connection. A window holding no rollups gives zero
   * counts. peakConnections / peakTimestamp cover the whole rollup retention;
   * every other figure covers the window.
   */
  getLatestStats(connectionId: string): ClientAnalyticsStats | null {
    return this.states.get(connectionId)?.latest ?? null;
  }

  getWindowMs(): number {
    return this.config.windowMs;
  }

  /**
   * Stats over the configured window merged across every connection, memoised
   * for one aggregate interval: the rollups only change once per aggregator
   * run, so re-reading every connection's window rows per request buys nothing.
   */
  getLatestStatsAllConnections(): Promise<ClientAnalyticsStats> {
    const now = Date.now();
    const cached = this.allConnectionsLatest;
    if (cached && now - cached.computedAt < this.config.aggregateIntervalMs && now >= cached.computedAt) {
      return cached.stats;
    }
    const stats = this.getStatsForRange(now - this.config.windowMs, now, undefined);
    const entry = { stats, computedAt: now };
    this.allConnectionsLatest = entry;
    // A failed read is not memoised: the next request retries.
    stats.catch(() => {
      if (this.allConnectionsLatest === entry) this.allConnectionsLatest = null;
    });
    return stats;
  }

  /** Stats merged from rollup buckets covering [startTime, endTime] (bucket-aligned); the peak is the peak within that range. */
  async getStatsForRange(startTime: number, endTime: number, connectionId?: string): Promise<ClientAnalyticsStats> {
    const rows = await this.budget.time('getClientAnalyticsRollups', connectionId, () =>
      this.storage.getClientAnalyticsRollups(
        clientRollupBucketStart(startTime),
        clientRollupBucketStart(endTime),
        connectionId,
      ),
    );
    return mergeRollupsIntoStats(rows, { currentCutoffMs: this.currentCutoffMs() });
  }

  /**
   * Stats over the configured window for one connection with the headline
   * peak taken over the whole rollup retention, as getLatestStats reports
   * them: the fallback before the aggregator's first run for the connection,
   * so the same request does not change its peak once that run completes.
   * Reads the retention peak from the connection's state when it holds a
   * current one, else from storage.
   */
  async getWindowStatsWithRetentionPeak(connectionId: string): Promise<ClientAnalyticsStats> {
    const now = Date.now();
    const horizon = this.retentionHorizon(now);
    const stats = await this.getStatsForRange(now - this.config.windowMs, now, connectionId);
    const state = this.states.get(connectionId);
    const peak =
      state && state.retentionPeakLoaded && !peakBeforeHorizon(state.retentionPeak, horizon)
        ? state.retentionPeak
        : await this.timed('getClientAnalyticsRollupPeak', connectionId, () =>
            this.storage.getClientAnalyticsRollupPeak(connectionId, horizon),
          );
    applyPeak(stats, betterPeak({ peak: stats.peakConnections, capturedAt: stats.peakTimestamp }, peak));
    return stats;
  }

  /** First bucket inside the rollup retention; older buckets are pruned. */
  private retentionHorizon(now: number): number {
    return clientRollupBucketStart(now - this.config.rollupRetentionMs);
  }

  /**
   * A connection counts toward cross-connection `current` if its newest batch
   * is within max(one bucket, two poll intervals) of the newest batch overall:
   * with a poll interval of 5 minutes or more, a fixed one-bucket cutoff would
   * drop a connection after a single missed poll. Read per merge, so a poll
   * interval changed in the settings applies on the next merge.
   */
  private currentCutoffMs(): number {
    const pollMs = this.settingsService?.getCachedSettings().clientAnalyticsPollIntervalMs;
    if (typeof pollMs !== 'number' || !Number.isFinite(pollMs) || pollMs <= 0) {
      return CLIENT_ANALYTICS_ROLLUP_BUCKET_MS;
    }
    return Math.max(CLIENT_ANALYTICS_ROLLUP_BUCKET_MS, 2 * pollMs);
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.states.delete(connectionId);
    this.pendingInit.delete(connectionId);
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    const id = ctx.connectionId;
    const now = Date.now();
    // Same gate as the snapshot writer: without CLIENT LIST no snapshots are
    // written for this connection, so there is nothing new to fold and no raw
    // read is made. The window recompute (rollups only) and retention still
    // run, so latest keeps following the window as it advances (down to zeros
    // once it empties) and old rollups are still pruned.
    const canFold = this.runtimeCapabilityTracker.isAvailable(id, 'canClientList');
    const state = canFold ? await this.getOrInitState(id, now) : this.getOrCreatePassiveState(id);
    if (state === null || this.states.get(id) !== state) return;

    // Read the retention peak on first use, and again once the horizon has
    // passed the stored peak's bucket (that bucket no longer counts).
    const horizon = this.retentionHorizon(now);
    let peakChanged = false;
    if (!state.retentionPeakLoaded || peakBeforeHorizon(state.retentionPeak, horizon)) {
      peakChanged = await this.loadRetentionPeak(id, state, horizon);
      if (this.states.get(id) !== state) return;
    }

    const windowStartBucket = clientRollupBucketStart(now - this.config.windowMs);
    let windowChanged = false;
    if (canFold) {
      const peakBeforeFold = state.retentionPeak;
      const folded = await this.runIncremental(id, state, now);
      windowChanged = folded;
      if (await this.runBackfill(id, state, now, windowStartBucket, folded)) {
        windowChanged = true;
      }
      if (this.states.get(id) !== state) return;
      // A backfilled bucket outside the window can still raise the retention peak.
      if (!samePeak(peakBeforeFold, state.retentionPeak)) peakChanged = true;
    }

    let recomputed = false;
    if (windowChanged || state.latest === null || state.lastWindowStartBucket !== windowStartBucket) {
      const rows = await this.timed('getClientAnalyticsRollups', id, () =>
        this.storage.getClientAnalyticsRollups(windowStartBucket, clientRollupBucketStart(now), id),
      );
      if (this.states.get(id) !== state) return;
      // An empty window merges to zero counts.
      const latest = mergeRollupsIntoStats(rows, { currentCutoffMs: this.currentCutoffMs() });
      state.windowPeak = { peak: latest.peakConnections, capturedAt: latest.peakTimestamp };
      state.latest = latest;
      state.computedAt = now;
      state.lastWindowStartBucket = windowStartBucket;
      recomputed = true;
    }
    // Headline peak over the whole rollup retention, from state (see
    // retentionPeak); per-name / per-user / per-pair peaks stay window-scoped.
    if (recomputed || peakChanged) this.applyRetentionPeak(state);

    if (await this.runRetention(id, state, now)) {
      // The prune may have removed the bucket holding the peak.
      if (this.states.get(id) !== state) return;
      if (await this.loadRetentionPeak(id, state, horizon)) this.applyRetentionPeak(state);
    }
    const elapsedMs = Date.now() - now;
    this.logger.debug(
      `Rollup run for ${id} took ${elapsedMs}ms (changed=${windowChanged}, recomputed=${recomputed}, ` +
        `backfill=${state.backfillDone ? 'done' : 'in progress'})`,
    );
    if (elapsedMs > this.config.aggregateIntervalMs) {
      this.logger.warn(
        `Rollup run for ${id} took ${elapsedMs}ms, longer than the ${this.config.aggregateIntervalMs}ms aggregate interval`,
      );
    }
  }

  private newState(watermark: number | null, coldStartFloor: number | null): ConnectionRollupState {
    return {
      watermark,
      scanCursor: watermark,
      latest: null,
      computedAt: 0,
      lastWindowStartBucket: null,
      backfillCursor: null,
      coldStartFloor,
      backfillTarget: null,
      backfillDone: false,
      backfillWaitingForData: false,
      backfillStartedAt: 0,
      backfillRowsFolded: 0,
      lastRetentionAt: 0,
      retentionPeak: null,
      retentionPeakLoaded: false,
      windowPeak: null,
    };
  }

  /** Read the retention peak from storage into state. Returns true when it changed. */
  private async loadRetentionPeak(id: string, state: ConnectionRollupState, horizon: number): Promise<boolean> {
    // One primary-key range read of two numeric columns, unlike merging the
    // whole retention's per-group JSON.
    const peak = await this.timed('getClientAnalyticsRollupPeak', id, () =>
      this.storage.getClientAnalyticsRollupPeak(id, horizon),
    );
    const changed = !state.retentionPeakLoaded || !samePeak(state.retentionPeak, peak);
    state.retentionPeak = peak;
    state.retentionPeakLoaded = true;
    return changed;
  }

  /**
   * Raise the in-state retention peak from rows just written. Rows before the
   * horizon do not count (the storage read excludes them). Returns true when
   * the peak changed.
   */
  private foldRetentionPeak(state: ConnectionRollupState, rows: ClientAnalyticsRollup[], now: number): boolean {
    if (!state.retentionPeakLoaded) return false;
    const horizon = this.retentionHorizon(now);
    let peak = state.retentionPeak;
    for (const row of rows) {
      if (row.bucketStart < horizon) continue;
      peak = betterPeak(peak, { peak: row.peakConnections, capturedAt: row.peakCapturedAt });
    }
    if (samePeak(peak, state.retentionPeak)) return false;
    state.retentionPeak = peak;
    return true;
  }

  /** Put the larger of the window's own peak and the retention peak into latest. */
  private applyRetentionPeak(state: ConnectionRollupState): void {
    if (!state.latest || !state.windowPeak) return;
    applyPeak(state.latest, betterPeak(state.windowPeak, state.retentionPeak));
  }

  /**
   * The state of a connection without CLIENT LIST: the existing one, or a
   * passive one (no watermark read, no cold-start lookback) that only carries
   * the window recompute and retention bookkeeping.
   */
  private getOrCreatePassiveState(id: string): ConnectionRollupState {
    let state = this.states.get(id);
    if (!state) {
      state = this.newState(null, null);
      this.states.set(id, state);
    }
    return state;
  }

  /**
   * The connection's state, initialised from storage on first use (or when
   * only a passive state exists); null when the connection was removed
   * meanwhile.
   */
  private async getOrInitState(id: string, now: number): Promise<ConnectionRollupState | null> {
    const existing = this.states.get(id);
    if (existing && existing.watermark !== null) return existing;
    const token = Symbol(id);
    this.pendingInit.set(id, token);
    const stored = await this.timed('getClientAnalyticsRollupWatermark', id, () =>
      this.storage.getClientAnalyticsRollupWatermark(id),
    );
    // The token is gone when the connection was removed while the read was
    // pending (or replaced by a newer init): this read is stale, install nothing.
    if (this.pendingInit.get(id) !== token) return null;
    this.pendingInit.delete(id);
    // Cold start: fold the recent past from a bucket boundary so the oldest
    // bucket is complete (the backfill never revisits a bucket that exists).
    const watermark =
      stored ??
      clientRollupBucketStart(now - Math.min(this.config.windowMs, COLD_START_LOOKBACK_MAX_MS)) - 1;
    const coldStartFloor = stored === null ? watermark + 1 : null;
    const current = this.states.get(id);
    if (existing && current === existing) {
      // Upgrade the passive state in place: latest, the window bookkeeping
      // and the retention clock carry over.
      existing.watermark = watermark;
      existing.scanCursor = watermark;
      existing.coldStartFloor = coldStartFloor;
      return existing;
    }
    const state = this.newState(watermark, coldStartFloor);
    // A state installed meanwhile wins; pollConnection then sees the mismatch and stops.
    if (!current) this.states.set(id, state);
    return state;
  }

  /** Fold everything newer than the watermark, one bounded chunk at a time. Returns true when rollups changed. */
  private async runIncremental(id: string, state: ConnectionRollupState, now: number): Promise<boolean> {
    let changed = false;
    for (let chunk = 0; chunk < this.config.backfillChunksPerRun; chunk++) {
      const from = state.scanCursor as number;
      if (from >= now) break;
      // Chunk the catch-up, but let the newest chunk run all the way to now:
      // a chunk capped just short of now would hide rows written since the
      // cap, and an empty chunk ending within the settle margin does not
      // advance the cursor (see below), so those rows would stay invisible
      // until the cap aged past the margin.
      let to = from + this.config.backfillChunkMs;
      if (to > now - EMPTY_CHUNK_SETTLE_MS) {
        to = now;
      }
      const groups = await this.timed('getClientSnapshotGroups', id, () =>
        this.storage.getClientSnapshotGroups(id, from, to),
      );
      if (this.states.get(id) !== state) return false;
      if (groups.length > 0) {
        const first = groups[0].capturedAt;
        const last = groups[groups.length - 1].capturedAt;
        const existingRows = await this.timed('getClientAnalyticsRollups', id, () =>
          this.storage.getClientAnalyticsRollups(clientRollupBucketStart(first), clientRollupBucketStart(last), id),
        );
        const updated = foldGroupsIntoRollups(id, groups, byBucket(existingRows), now);
        if (updated.length > 0) {
          await this.timed('upsertClientAnalyticsRollups', id, () => this.storage.upsertClientAnalyticsRollups(updated));
          this.foldRetentionPeak(state, updated, now);
          changed = true;
        }
        state.watermark = Math.max(state.watermark ?? last, last);
      }
      const watermark = state.watermark as number;
      const settled = to <= now - EMPTY_CHUNK_SETTLE_MS;
      if (groups.length === 0 && settled) {
        // An empty settled chunk usually means a gap (monitor downtime): one
        // index probe finds the next batch, and the cursor jumps over the
        // empty time to just before it instead of walking the gap a chunk at
        // a time. The jump stays inside the settled past, so nothing the
        // writer may still be committing is skipped, and every chunk read
        // afterwards keeps its usual bounds.
        const next = await this.timed('getClientSnapshotNextCapturedAt', id, () =>
          this.storage.getClientSnapshotNextCapturedAt(id, to),
        );
        if (this.states.get(id) !== state) return false;
        const settledEdge = now - EMPTY_CHUNK_SETTLE_MS;
        if (next === null) {
          // Nothing newer at all: the settled past is empty, so the next run
          // starts at the newest chunk (settle edge to now).
          state.scanCursor = Math.max(to, watermark, settledEdge);
          break;
        }
        state.scanCursor = Math.max(to, watermark, Math.min(next - 1, settledEdge));
        continue;
      }
      // A settled chunk moves the cursor past itself. The newest chunk (the
      // one running to now) keeps the cursor at its own start, never below:
      // falling back to the watermark would discard the progress made through
      // settled empty chunks, so a connection with a long gap would re-scan
      // the whole gap every run. Re-reading just this chunk next time still
      // picks up batches committed late.
      state.scanCursor = settled ? Math.max(to, watermark) : Math.max(from, watermark);
      if (to >= now) break;
    }
    return changed;
  }

  /**
   * Walk backwards from the oldest rollup bucket, a few chunks per run, until
   * the oldest raw snapshot (or the rollup retention horizon) is covered.
   * Returns true when it wrote a bucket inside the current window.
   * `incrementalFolded` wakes a backfill that is waiting for data.
   */
  private async runBackfill(
    id: string,
    state: ConnectionRollupState,
    now: number,
    windowStartBucket: number,
    incrementalFolded: boolean,
  ): Promise<boolean> {
    if (state.backfillDone) return false;
    if (state.backfillWaitingForData) {
      if (!incrementalFolded) return false;
      state.backfillWaitingForData = false;
    }
    if (!this.snapshotIndexReady) {
      const ready = await this.timed('isClientSnapshotIndexReady', id, () => this.storage.isClientSnapshotIndexReady());
      if (!ready) {
        this.warnIndexWait(now);
        return false;
      }
      this.snapshotIndexReady = true;
    }
    if (this.states.get(id) !== state) return false;

    if (state.backfillCursor === null) {
      const storedFloor = await this.timed('getClientAnalyticsRollupFloor', id, () =>
        this.storage.getClientAnalyticsRollupFloor(id),
      );
      // No rollup yet (nothing captured during the cold-start lookback): the
      // lookback start is still a complete-bucket boundary to walk back from.
      const floor = storedFloor ?? state.coldStartFloor;
      if (floor === null) {
        state.backfillWaitingForData = true;
        return false;
      }
      const bounds = await this.timed('getClientSnapshotBounds', id, () => this.storage.getClientSnapshotBounds(id));
      if (this.states.get(id) !== state) return false;
      if (bounds === null && storedFloor === null) {
        state.backfillWaitingForData = true;
        return false;
      }
      const target = Math.max(bounds?.earliest ?? floor, now - this.config.rollupRetentionMs);
      state.backfillCursor = floor;
      state.backfillTarget = target;
      if (floor <= target) {
        state.backfillDone = true;
        return false;
      }
      state.backfillStartedAt = now;
      state.backfillRowsFolded = 0;
      const estimatedChunks = Math.ceil((floor - target) / this.config.backfillChunkMs);
      this.logger.log(
        `Client analytics backfill for ${id} starting: raw snapshots span ` +
          `${new Date(bounds?.earliest ?? floor).toISOString()} .. ${new Date(bounds?.latest ?? floor).toISOString()}, ` +
          `folding back to ${new Date(target).toISOString()} in ~${estimatedChunks} chunk(s) of ${this.config.backfillChunkMs}ms`,
      );
    }

    let touchedWindow = false;
    for (let chunk = 0; chunk < this.config.backfillChunksPerRun; chunk++) {
      const cursor = state.backfillCursor as number;
      const target = state.backfillTarget as number;
      if (cursor <= target) break;
      // captured_at in [cursor - chunk, cursor - 1]: whole buckets below the floor.
      const lower = cursor - this.config.backfillChunkMs;
      const groups = await this.timed('getClientSnapshotGroups', id, () =>
        this.storage.getClientSnapshotGroups(id, lower - 1, cursor - 1),
      );
      if (this.states.get(id) !== state) return false;
      if (groups.length > 0) {
        const rows = foldGroupsIntoRollups(id, groups, new Map(), now);
        if (rows.length > 0) {
          await this.timed('upsertClientAnalyticsRollups', id, () => this.storage.upsertClientAnalyticsRollups(rows));
          this.foldRetentionPeak(state, rows, now);
          if (rows.some((r) => r.bucketStart >= windowStartBucket)) touchedWindow = true;
        }
        state.backfillRowsFolded += groups.reduce((sum, g) => sum + g.count, 0);
      }
      state.backfillCursor = lower;
    }

    if ((state.backfillCursor as number) <= (state.backfillTarget as number)) {
      state.backfillDone = true;
      this.logger.log(
        `Client analytics backfill for ${id} finished in ${Date.now() - state.backfillStartedAt}ms, ` +
          `${state.backfillRowsFolded} snapshot row(s) folded`,
      );
    }
    return touchedWindow;
  }

  /**
   * Without a valid index the backfill never starts, so backfillDone stays
   * false and the raw snapshot prune is skipped too. Say so, at most once per
   * hour per process, instead of failing silently.
   */
  private warnIndexWait(now: number): void {
    if (this.lastIndexWaitWarnAt !== null && now - this.lastIndexWaitWarnAt < INDEX_WAIT_WARN_INTERVAL_MS) return;
    this.lastIndexWaitWarnAt = now;
    this.logger.warn(
      'Client analytics backfill and raw snapshot pruning (CLIENT_ANALYTICS_RAW_RETENTION_DAYS) are waiting for ' +
        'index idx_client_connection_captured on client_snapshots to become valid; if this persists, check the ' +
        'startup logs for a failed build of idx_client_connection_captured',
    );
  }

  /** Returns true when the rollup prune ran (the caller re-reads the retention peak). */
  private async runRetention(id: string, state: ConnectionRollupState, now: number): Promise<boolean> {
    if (now - state.lastRetentionAt < RETENTION_INTERVAL_MS) return false;
    state.lastRetentionAt = now;
    const rollupCutoff = this.retentionHorizon(now);
    await this.timed('pruneOldClientAnalyticsRollups', id, () =>
      this.storage.pruneOldClientAnalyticsRollups(rollupCutoff, id),
    );
    // Raw rows are only pruned once the backfill has folded the history they
    // hold: pruning first would drop snapshots that never reached a rollup.
    if (this.config.rawRetentionMs !== null && state.backfillDone) {
      const rawCutoff = now - this.config.rawRetentionMs;
      await this.timed('pruneOldClientSnapshots', id, () => this.storage.pruneOldClientSnapshots(rawCutoff, id));
    }
    return true;
  }

  private timed<T>(name: string, connectionId: string, fn: () => Promise<T>): Promise<T> {
    return this.budget.time(name, connectionId, fn);
  }
}

/** Same tie rule as the merge and the adapters: the larger peak, an equal one going to the earliest capture. */
function betterPeak(current: PeakPoint | null, candidate: PeakPoint | null): PeakPoint | null {
  if (!candidate) return current;
  if (
    !current ||
    candidate.peak > current.peak ||
    (candidate.peak === current.peak && candidate.capturedAt < current.capturedAt)
  ) {
    return candidate;
  }
  return current;
}

function samePeak(a: PeakPoint | null, b: PeakPoint | null): boolean {
  return a === b || (a !== null && b !== null && a.peak === b.peak && a.capturedAt === b.capturedAt);
}

/** Whether the peak's bucket has fallen before the retention horizon (the storage read no longer covers it). */
function peakBeforeHorizon(peak: PeakPoint | null, horizon: number): boolean {
  return peak !== null && clientRollupBucketStart(peak.capturedAt) < horizon;
}

function applyPeak(stats: ClientAnalyticsStats, peak: PeakPoint | null): void {
  if (!peak) return;
  stats.peakConnections = peak.peak;
  stats.peakTimestamp = peak.capturedAt;
}

function byBucket(rows: ClientAnalyticsRollup[]): Map<number, ClientAnalyticsRollup> {
  return new Map(rows.map((r) => [r.bucketStart, r]));
}
