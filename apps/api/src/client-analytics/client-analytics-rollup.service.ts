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
 * committing the batch it captured, so the cursor stays at the watermark.
 */
const EMPTY_CHUNK_SETTLE_MS = 5 * 60_000;
const RETENTION_INTERVAL_MS = HOUR_MS;

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

interface ConnectionRollupState {
  /** Newest captured_at folded into the rollups. */
  watermark: number | null;
  /** Lower bound of the next incremental read (>= watermark only across settled empty chunks). */
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

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    configService: ConfigService,
    private readonly runtimeCapabilityTracker: RuntimeCapabilityTracker,
    @Optional() @Inject(CLIENT_ANALYTICS_ROLLUP_TUNING) tuning?: Partial<ClientAnalyticsRollupTuning>,
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
   * Latest stats over the configured window, or null before the first
   * aggregation. peakConnections / peakTimestamp cover the whole rollup
   * retention; every other figure covers the window.
   */
  getLatestStats(connectionId: string): ClientAnalyticsStats | null {
    return this.states.get(connectionId)?.latest ?? null;
  }

  getWindowMs(): number {
    return this.config.windowMs;
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
    return mergeRollupsIntoStats(rows);
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.states.delete(connectionId);
    this.pendingInit.delete(connectionId);
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    const id = ctx.connectionId;
    // Same gate as the snapshot writer: without CLIENT LIST no snapshots are
    // ever written for this connection, so there is nothing to fold.
    if (!this.runtimeCapabilityTracker.isAvailable(id, 'canClientList')) return;
    const now = Date.now();
    const state = await this.getOrInitState(id, now);
    if (state === null || this.states.get(id) !== state) return;

    const windowStartBucket = clientRollupBucketStart(now - this.config.windowMs);
    const folded = await this.runIncremental(id, state, now);
    let windowChanged = folded;
    if (await this.runBackfill(id, state, now, windowStartBucket, folded)) {
      windowChanged = true;
    }
    if (this.states.get(id) !== state) return;

    let recomputed = false;
    if (windowChanged || state.latest === null || state.lastWindowStartBucket !== windowStartBucket) {
      const rows = await this.timed('getClientAnalyticsRollups', id, () =>
        this.storage.getClientAnalyticsRollups(windowStartBucket, clientRollupBucketStart(now), id),
      );
      // Headline peak over the whole rollup retention: one primary-key range
      // read of two numeric columns, unlike merging 90 days of per-group JSON.
      // Per-name / per-user / per-pair peaks stay window-scoped.
      const retentionPeak = await this.timed('getClientAnalyticsRollupPeak', id, () =>
        this.storage.getClientAnalyticsRollupPeak(id, clientRollupBucketStart(now - this.config.rollupRetentionMs)),
      );
      if (this.states.get(id) !== state) return;
      const latest = mergeRollupsIntoStats(rows);
      // Same tie rule as the merge and the adapters: an equal peak goes to
      // the earliest capture, which the retention read may hold.
      if (
        retentionPeak &&
        (retentionPeak.peak > latest.peakConnections ||
          (retentionPeak.peak === latest.peakConnections &&
            retentionPeak.capturedAt < latest.peakTimestamp))
      ) {
        latest.peakConnections = retentionPeak.peak;
        latest.peakTimestamp = retentionPeak.capturedAt;
      }
      state.latest = latest;
      state.computedAt = now;
      state.lastWindowStartBucket = windowStartBucket;
      recomputed = true;
    }

    await this.runRetention(id, state, now);
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

  /** The connection's state, initialised from storage on first use; null when the connection was removed meanwhile. */
  private async getOrInitState(id: string, now: number): Promise<ConnectionRollupState | null> {
    const existing = this.states.get(id);
    if (existing) return existing;
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
    const state: ConnectionRollupState = {
      watermark,
      scanCursor: watermark,
      latest: null,
      computedAt: 0,
      lastWindowStartBucket: null,
      backfillCursor: null,
      coldStartFloor: stored === null ? watermark + 1 : null,
      backfillTarget: null,
      backfillDone: false,
      backfillWaitingForData: false,
      backfillStartedAt: 0,
      backfillRowsFolded: 0,
      lastRetentionAt: 0,
    };
    // A state installed meanwhile wins; pollConnection then sees the mismatch and stops.
    if (!this.states.has(id)) this.states.set(id, state);
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
          changed = true;
        }
        state.watermark = Math.max(state.watermark ?? last, last);
      }
      const watermark = state.watermark as number;
      state.scanCursor = to <= now - EMPTY_CHUNK_SETTLE_MS ? Math.max(to, watermark) : watermark;
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
      if (!ready) return false;
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

  private async runRetention(id: string, state: ConnectionRollupState, now: number): Promise<void> {
    if (now - state.lastRetentionAt < RETENTION_INTERVAL_MS) return;
    state.lastRetentionAt = now;
    const rollupCutoff = clientRollupBucketStart(now - this.config.rollupRetentionMs);
    await this.timed('pruneOldClientAnalyticsRollups', id, () =>
      this.storage.pruneOldClientAnalyticsRollups(rollupCutoff, id),
    );
    // Raw rows are only pruned once the backfill has folded the history they
    // hold: pruning first would drop snapshots that never reached a rollup.
    if (this.config.rawRetentionMs !== null && state.backfillDone) {
      const rawCutoff = now - this.config.rawRetentionMs;
      await this.timed('pruneOldClientSnapshots', id, () => this.storage.pruneOldClientSnapshots(rawCutoff, id));
    }
  }

  private timed<T>(name: string, connectionId: string, fn: () => Promise<T>): Promise<T> {
    return this.budget.time(name, connectionId, fn);
  }
}

function byBucket(rows: ClientAnalyticsRollup[]): Map<number, ClientAnalyticsRollup> {
  return new Map(rows.map((r) => [r.bucketStart, r]));
}
