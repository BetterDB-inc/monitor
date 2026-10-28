import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CAPTURED_LOG_TYPES,
  LOG_CAPTURE_MAX_LEN_PARAMETER,
  type CapturedLogType,
  type LogCaptureGap,
  type LogCaptureGapQuery,
  type LogCaptureSummary,
} from '@betterdb/shared';
import type { StoragePort } from '../common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { LOG_CATCH_UP_MAX_FETCH, summarizeLogGaps } from './capture-gap';

/** CONFIG GET results are cached this long per connection and parameter. */
const MAX_LEN_CACHE_TTL_MS = 5 * 60_000;

const COMMANDLOG_TYPES: ReadonlySet<CapturedLogType> = new Set([
  'commandlog-slow',
  'commandlog-large-request',
  'commandlog-large-reply',
]);

@Injectable()
export class LogCaptureService {
  private readonly logger = new Logger(LogCaptureService.name);
  private readonly maxLenCache = new Map<string, { value: number | null; at: number }>();

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly connectionRegistry: ConnectionRegistry,
  ) {}

  async getSummary(connectionId: string | undefined, windowMs: number): Promise<LogCaptureSummary> {
    const id = this.resolveConnectionId(connectionId);
    const now = Date.now();
    const since = now - windowMs;
    const aggregates = await this.storage.getLogCaptureGapRepository().summarize(id, since);
    const typesWithGaps = new Set(aggregates.map((aggregate) => aggregate.logType));

    const logs = [];
    for (const logType of this.capturedLogTypes(id, typesWithGaps)) {
      // Only ask the server when there is something to recommend against.
      const currentMaxLen = typesWithGaps.has(logType) ? await this.readMaxLen(id, logType, now) : null;
      logs.push(summarizeLogGaps(logType, aggregates, currentMaxLen));
    }

    return {
      connectionId: id,
      windowMs,
      since,
      computedAt: now,
      totalMissingEntries: logs.reduce((sum, log) => sum + log.missingEntries, 0),
      maxFetchPerPoll: LOG_CATCH_UP_MAX_FETCH,
      logs,
    };
  }

  async listGaps(
    connectionId: string | undefined,
    query: Omit<LogCaptureGapQuery, 'connectionId'>,
  ): Promise<LogCaptureGap[]> {
    const id = this.resolveConnectionId(connectionId);
    return this.storage.getLogCaptureGapRepository().list({ ...query, connectionId: id });
  }

  private resolveConnectionId(connectionId: string | undefined): string {
    const id = connectionId || this.connectionRegistry.getDefaultId();
    if (!id) {
      throw new NotFoundException('No connection available');
    }
    return id;
  }

  /**
   * Logs this connection captures: SLOWLOG always, COMMANDLOG types only when
   * the server has COMMANDLOG. Any type that already has stored gaps is kept
   * even if the capability has since gone away, so history is never hidden.
   */
  private capturedLogTypes(connectionId: string, typesWithGaps: ReadonlySet<CapturedLogType>): CapturedLogType[] {
    let hasCommandLog = false;
    try {
      hasCommandLog = this.connectionRegistry.get(connectionId).getCapabilities().hasCommandLog;
    } catch {
      hasCommandLog = false;
    }
    return CAPTURED_LOG_TYPES.filter((logType) => {
      if (typesWithGaps.has(logType)) return true;
      return COMMANDLOG_TYPES.has(logType) ? hasCommandLog : true;
    });
  }

  /** Current `*-max-len` for a log, or null when CONFIG is unavailable or unreadable. */
  private async readMaxLen(connectionId: string, logType: CapturedLogType, now: number): Promise<number | null> {
    const parameter = LOG_CAPTURE_MAX_LEN_PARAMETER[logType];
    const cacheKey = `${connectionId}:${parameter}`;
    const cached = this.maxLenCache.get(cacheKey);
    if (cached && now - cached.at < MAX_LEN_CACHE_TTL_MS) return cached.value;

    let value: number | null = null;
    try {
      const client = this.connectionRegistry.get(connectionId);
      if (client.getCapabilities().hasConfig) {
        const raw = await client.getConfigValue(parameter);
        const parsed = raw === null ? NaN : Number(raw);
        value = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
      }
    } catch (error) {
      this.logger.debug(
        `Could not read ${parameter} for ${connectionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      value = null;
    }
    this.maxLenCache.set(cacheKey, { value, at: now });
    return value;
  }
}
