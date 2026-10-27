import { BadRequestException, Controller, Get, Logger, Param, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Feature, type CacheSimulatorSnapshot } from '@betterdb/shared';
import { LicenseGuard } from '@proprietary/licenses';
import { RequiresFeature } from '@proprietary/licenses/requires-feature.decorator';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { ValidateInstanceIdPipe, mapMcpError } from '@app/mcp/mcp-helpers';
import { CacheSimulatorService } from './cache-simulator.service';

@Controller('mcp')
@UseGuards(AgentTokenGuard, LicenseGuard)
@RequiresFeature(Feature.CACHE_SIZE_SIMULATOR)
export class McpCacheSimulatorController {
  private readonly logger = new Logger(McpCacheSimulatorController.name);

  constructor(private readonly simulator: CacheSimulatorService) {}

  /**
   * Same contract as GET /cache-simulator/snapshot: the first call starts a
   * bounded stratified sample and returns status="sampling" with progress;
   * poll until status is "ready" or "failed". Results are cached 15 min
   * unless refresh=true.
   */
  @Get('instance/:id/cache-simulator')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async getSnapshot(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('refresh') refresh?: string,
  ): Promise<CacheSimulatorSnapshot> {
    if (refresh !== undefined && refresh !== '' && refresh !== 'true' && refresh !== 'false') {
      throw new BadRequestException('refresh must be true or false');
    }
    try {
      return await this.simulator.snapshot(id, refresh === 'true');
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get cache size simulation');
    }
  }
}
