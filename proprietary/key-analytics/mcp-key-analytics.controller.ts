import { BadRequestException, Controller, Get, Logger, Param, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { KeyPatternSnapshot } from '@betterdb/shared';
import { LicenseGuard } from '@proprietary/licenses';
import { RequiresFeature } from '@proprietary/licenses/requires-feature.decorator';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import {
  DAY_MS,
  ValidateInstanceIdPipe,
  downsampleEvenly,
  evenSampling,
  mapMcpError,
  parseMaxPoints,
  parseOptionalDbIndex,
  resolveTimeRange,
  safeLimit,
  safeParseInt,
} from '@app/mcp/mcp-helpers';
import { KeyAnalyticsService } from './key-analytics.service';

export const MCP_PATTERN_TREND_DEFAULT_LOOKBACK_MS = 7 * DAY_MS;
export const MCP_PATTERN_TREND_MAX_SPAN_MS = 90 * DAY_MS;
const MAX_PATTERN_LENGTH = 512;
/** Row cap of the pattern snapshot query: fetch a whole snapshot, then apply the caller's limit to the total. */
const PATTERN_FETCH_LIMIT = 500;

function optionalPattern(value: string | undefined): string | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (value.length > MAX_PATTERN_LENGTH) {
    throw new BadRequestException(`pattern must be at most ${MAX_PATTERN_LENGTH} characters`);
  }
  return value;
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

/**
 * Optional [startTime, endTime] filter for the summary and pattern routes:
 * with neither bound the query stays open-ended, otherwise the range is
 * validated like the trend route (400 on garbage, inverted or over-wide).
 */
function optionalTimeRange(
  startTime: string | undefined,
  endTime: string | undefined,
): { from: number | undefined; to: number | undefined } {
  if (isBlank(startTime) && isBlank(endTime)) {
    return { from: undefined, to: undefined };
  }
  const range = resolveTimeRange(startTime, endTime, MCP_PATTERN_TREND_MAX_SPAN_MS, MCP_PATTERN_TREND_MAX_SPAN_MS);
  return {
    from: isBlank(startTime) ? undefined : range.from,
    to: isBlank(endTime) ? undefined : range.to,
  };
}

@Controller('mcp')
@UseGuards(AgentTokenGuard, LicenseGuard)
@RequiresFeature('keyAnalytics')
export class McpKeyAnalyticsController {
  private readonly logger = new Logger(McpKeyAnalyticsController.name);

  constructor(
    private readonly keyAnalytics: KeyAnalyticsService,
    private readonly registry: ConnectionRegistry,
  ) {}

  @Get('instance/:id/largest-keys')
  async getLargestKeys(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('limit') limit?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ) {
    const entries = await this.keyAnalytics.getLargestKeys({
      connectionId: id,
      limit: safeLimit(limit, 50),
      startTime: safeParseInt(startTime),
      endTime: safeParseInt(endTime),
      latest: true,
    });
    return { entries };
  }

  /**
   * Keyspace summary (totals, hot/cold/stale counts, per-pattern breakdown) plus the logical
   * databases that have stored analytics. summary is null for a cluster
   * member whose analytics are collected on its seed connection.
   */
  @Get('instance/:id/key-analytics/summary')
  async getSummary(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('db') db?: string,
  ) {
    const dbIndex = parseOptionalDbIndex(db);
    const range = optionalTimeRange(startTime, endTime);
    try {
      this.registry.get(id);
      const [summary, databases] = await Promise.all([
        this.keyAnalytics.getSummary(range.from, range.to, id, dbIndex),
        this.keyAnalytics.getDatabases(id),
      ]);
      return { summary, databases };
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get key analytics summary');
    }
  }

  /**
   * Latest snapshot per logical database only. The storage query applies its
   * limit per db and orders by timestamp, which mixes collection runs, so the
   * whole window is fetched, reduced to each db's newest snapshot, ranked by
   * key count, and `limit` (max 500) is applied to the total.
   */
  @Get('instance/:id/key-analytics/patterns')
  async getPatterns(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('pattern') pattern?: string,
    @Query('db') db?: string,
    @Query('limit') limit?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ) {
    const resolvedPattern = optionalPattern(pattern);
    const dbIndex = parseOptionalDbIndex(db);
    const total = safeLimit(limit, 50, 500);
    const range = optionalTimeRange(startTime, endTime);
    try {
      this.registry.get(id);
      const rows: KeyPatternSnapshot[] = await this.keyAnalytics.getPatternSnapshots({
        connectionId: id,
        pattern: resolvedPattern,
        db: dbIndex,
        limit: PATTERN_FETCH_LIMIT,
        startTime: range.from,
        endTime: range.to,
      });
      const latestByDb = new Map<number, number>();
      for (const row of rows) {
        const rowDb = row.db ?? 0;
        latestByDb.set(rowDb, Math.max(latestByDb.get(rowDb) ?? 0, row.timestamp));
      }
      const patterns = rows
        .filter((row) => row.timestamp === latestByDb.get(row.db ?? 0))
        .sort((a, b) => {
          return (
            b.keyCount - a.keyCount ||
            (a.db ?? 0) - (b.db ?? 0) ||
            (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0)
          );
        })
        .slice(0, total);
      return { patterns, snapshotTimestamps: Object.fromEntries(latestByDb) };
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get key patterns');
    }
  }

  @Get('instance/:id/key-analytics/patterns/trend')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async getPatternTrend(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('pattern') pattern?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('db') db?: string,
    @Query('maxPoints') maxPoints?: string,
  ) {
    const resolvedPattern = optionalPattern(pattern);
    if (resolvedPattern === undefined) {
      throw new BadRequestException('pattern is required');
    }
    const budget = parseMaxPoints(maxPoints);
    const range = resolveTimeRange(startTime, endTime, MCP_PATTERN_TREND_DEFAULT_LOOKBACK_MS, MCP_PATTERN_TREND_MAX_SPAN_MS);
    const dbIndex = parseOptionalDbIndex(db);
    try {
      this.registry.get(id);
      const all = await this.keyAnalytics.getPatternTrends(resolvedPattern, range.from, range.to, id, dbIndex);
      // Trend rows are already summed per timestamp, so they form a single series.
      const points = downsampleEvenly(all, budget);
      return {
        pattern: resolvedPattern,
        startTime: range.from,
        endTime: range.to,
        points,
        sampling: evenSampling(all.length, points.length, budget),
      };
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get key pattern trend');
    }
  }
}
