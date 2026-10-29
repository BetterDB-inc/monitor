import { BadRequestException, Controller, Get, Logger, Param, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Feature, type CacheSimulatorSnapshot } from '@betterdb/shared';
import { LicenseGuard } from '@proprietary/licenses';
import { RequiresFeature } from '@proprietary/licenses/requires-feature.decorator';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { ValidateInstanceIdPipe, mapMcpError } from '@app/mcp/mcp-helpers';
import { CacheSimulatorService } from './cache-simulator.service';

export interface CacheSimulatorNotStarted {
  status: 'none';
  message: string;
}

@Controller('mcp')
@UseGuards(AgentTokenGuard, LicenseGuard)
@RequiresFeature(Feature.CACHE_SIZE_SIMULATOR)
export class McpCacheSimulatorController {
  private readonly logger = new Logger(McpCacheSimulatorController.name);

  constructor(private readonly simulator: CacheSimulatorService) {}

  /**
   * Read-only: returns the current job progress or the cached estimate
   * (status "sampling" | "ready" | "failed"), or status "none" when nothing
   * has been sampled yet. Never starts sampling, so polling is cheap.
   */
  @Get('instance/:id/cache-simulator')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  async getSnapshot(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('refresh') refresh?: string,
  ): Promise<CacheSimulatorSnapshot | CacheSimulatorNotStarted> {
    if (refresh !== undefined && refresh !== '' && refresh !== 'false') {
      throw new BadRequestException('use /cache-simulator/refresh to start sampling');
    }
    try {
      const current = await this.simulator.current(id);
      return current ?? {
        status: 'none',
        message: 'No estimate yet. Start a sampling job with /cache-simulator/refresh, then poll this route.',
      };
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get cache size simulation');
    }
  }

  /** Starts (or joins) a bounded stratified SCAN + MEMORY USAGE sampling job. */
  @Get('instance/:id/cache-simulator/refresh')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async refreshSnapshot(@Param('id', ValidateInstanceIdPipe) id: string): Promise<CacheSimulatorSnapshot> {
    try {
      return await this.simulator.snapshot(id, true);
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to start cache size simulation');
    }
  }
}
