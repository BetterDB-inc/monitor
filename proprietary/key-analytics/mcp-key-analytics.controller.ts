import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { LicenseGuard } from '@proprietary/licenses';
import { RequiresFeature } from '@proprietary/licenses/requires-feature.decorator';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import {
  DAY_MS,
  ValidateInstanceIdPipe,
  parseOptionalDbIndex,
  resolveTimeRange,
  safeLimit,
  safeParseInt,
} from '@app/mcp/mcp-helpers';
import { KeyAnalyticsService } from './key-analytics.service';

export const MCP_PATTERN_TREND_DEFAULT_LOOKBACK_MS = 7 * DAY_MS;
export const MCP_PATTERN_TREND_MAX_SPAN_MS = 90 * DAY_MS;
const MAX_PATTERN_LENGTH = 512;

function optionalPattern(value: string | undefined): string | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (value.length > MAX_PATTERN_LENGTH) {
    throw new BadRequestException(`pattern must be at most ${MAX_PATTERN_LENGTH} characters`);
  }
  return value;
}

@Controller('mcp')
@UseGuards(AgentTokenGuard, LicenseGuard)
@RequiresFeature('keyAnalytics')
export class McpKeyAnalyticsController {
  constructor(private readonly keyAnalytics: KeyAnalyticsService) {}

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
    const [summary, databases] = await Promise.all([
      this.keyAnalytics.getSummary(safeParseInt(startTime), safeParseInt(endTime), id, dbIndex),
      this.keyAnalytics.getDatabases(id),
    ]);
    return { summary, databases };
  }

  @Get('instance/:id/key-analytics/patterns')
  async getPatterns(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('pattern') pattern?: string,
    @Query('db') db?: string,
    @Query('limit') limit?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ) {
    const patterns = await this.keyAnalytics.getPatternSnapshots({
      connectionId: id,
      pattern: optionalPattern(pattern),
      db: parseOptionalDbIndex(db),
      limit: safeLimit(limit, 50, 500),
      startTime: safeParseInt(startTime),
      endTime: safeParseInt(endTime),
    });
    return { patterns };
  }

  @Get('instance/:id/key-analytics/patterns/trend')
  async getPatternTrend(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('pattern') pattern?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('db') db?: string,
  ) {
    const resolvedPattern = optionalPattern(pattern);
    if (resolvedPattern === undefined) {
      throw new BadRequestException('pattern is required');
    }
    const range = resolveTimeRange(startTime, endTime, MCP_PATTERN_TREND_DEFAULT_LOOKBACK_MS, MCP_PATTERN_TREND_MAX_SPAN_MS);
    const points = await this.keyAnalytics.getPatternTrends(resolvedPattern, range.from, range.to, id, parseOptionalDbIndex(db));
    return { pattern: resolvedPattern, startTime: range.from, endTime: range.to, points };
  }
}
