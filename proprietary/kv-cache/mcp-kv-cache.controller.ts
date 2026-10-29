import { BadRequestException, Controller, Get, Logger, Param, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  Feature,
  type KvCacheEngine,
  type KvCacheFootprintSnapshot,
  type KvCacheSamplesResponse,
  type KvCacheStatus,
} from '@betterdb/shared';
import { LicenseGuard } from '@proprietary/licenses';
import { RequiresFeature } from '@proprietary/licenses/requires-feature.decorator';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import {
  DAY_MS,
  type SamplingInfo,
  ValidateInstanceIdPipe,
  downsampleEvenly,
  downsampleSeries,
  evenSampling,
  mapMcpError,
  parseMaxPoints,
  redactScrapeUrl,
  redactUrlCredentials,
  resolveTimeRange,
} from '@app/mcp/mcp-helpers';
import { KvCacheSamplesService } from './kv-cache-samples.service';
import { KvCacheStatusService } from './kv-cache-status.service';

export const MCP_KV_CACHE_DEFAULT_LOOKBACK_MS = DAY_MS;
/** Matches SAMPLES_MAX_RANGE_MS (31 d) in kv-cache-samples.service.ts. */
export const MCP_KV_CACHE_MAX_SPAN_MS = 31 * DAY_MS;
const MAX_FILTER_LENGTH = 200;
/** History routes read months of stored samples, so they get a tighter limit than plain status reads. */
const HISTORY_THROTTLE = { default: { limit: 30, ttl: 60000 } };

/** Engine projection safe for agents: scrape URL reduced to scheme://host/path, credentials stripped from lastError. */
export function redactEngine(engine: KvCacheEngine): KvCacheEngine {
  return {
    ...engine,
    scrapeUrl: redactScrapeUrl(engine.scrapeUrl),
    lastError: engine.lastError === null ? null : redactUrlCredentials(engine.lastError),
  };
}

function optionalFilter(name: string, value: string | undefined): string | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (value.length > MAX_FILTER_LENGTH) {
    throw new BadRequestException(`${name} must be at most ${MAX_FILTER_LENGTH} characters`);
  }
  return value;
}

@Controller('mcp')
@UseGuards(AgentTokenGuard, LicenseGuard)
@RequiresFeature(Feature.KV_CACHE_MONITORING)
export class McpKvCacheController {
  private readonly logger = new Logger(McpKvCacheController.name);

  constructor(
    private readonly status: KvCacheStatusService,
    private readonly samples: KvCacheSamplesService,
    private readonly registry: ConnectionRegistry,
  ) {}

  @Get('instance/:id/kv-cache/status')
  async getStatus(@Param('id', ValidateInstanceIdPipe) id: string): Promise<KvCacheStatus> {
    try {
      this.registry.get(id);
      const status = await this.status.getStatus(id);
      return { ...status, engines: status.engines.map(redactEngine) };
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get KV cache status');
    }
  }

  /**
   * The samples service buckets per engine and per model (width grows with the
   * range) but has no bucket-width input, so the result is thinned to
   * `maxPoints` across all engine x model series rather than re-bucketed.
   */
  @Get('instance/:id/kv-cache/hit-rate')
  @Throttle(HISTORY_THROTTLE)
  async getHitRate(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('engineId') engineId?: string,
    @Query('model') model?: string,
    @Query('maxPoints') maxPoints?: string,
  ): Promise<KvCacheSamplesResponse & { sampling: SamplingInfo }> {
    const budget = parseMaxPoints(maxPoints);
    const range = resolveTimeRange(startTime, endTime, MCP_KV_CACHE_DEFAULT_LOOKBACK_MS, MCP_KV_CACHE_MAX_SPAN_MS);
    const engine = optionalFilter('engineId', engineId);
    const modelFilter = optionalFilter('model', model);
    try {
      this.registry.get(id);
      const response = await this.samples.getSamples(id, { ...range, engineId: engine, model: modelFilter });
      const { rows, sampling } = downsampleSeries(
        response.buckets,
        (bucket) => `${bucket.engineId}|${bucket.modelName}`,
        budget,
      );
      return { ...response, buckets: rows, sampling };
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get KV cache hit rate');
    }
  }

  @Get('instance/:id/kv-cache/footprint-history')
  @Throttle(HISTORY_THROTTLE)
  async getFootprintHistory(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('maxPoints') maxPoints?: string,
  ): Promise<{ snapshots: KvCacheFootprintSnapshot[]; sampling: SamplingInfo }> {
    const budget = parseMaxPoints(maxPoints);
    const range = resolveTimeRange(startTime, endTime, MCP_KV_CACHE_DEFAULT_LOOKBACK_MS, MCP_KV_CACHE_MAX_SPAN_MS);
    try {
      this.registry.get(id);
      const snapshots = await this.status.getFootprintHistory(id, range.from, range.to);
      const sampled = downsampleEvenly(snapshots, budget);
      return { snapshots: sampled, sampling: evenSampling(snapshots.length, sampled.length, budget) };
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get KV cache footprint history');
    }
  }
}
