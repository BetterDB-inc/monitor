import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Feature, type CacheSimulatorSnapshot } from '@betterdb/shared';
import { LicenseGuard } from '@proprietary/licenses';
import { RequiresFeature } from '@proprietary/licenses/requires-feature.decorator';
import { ConnectionId, CONNECTION_ID_HEADER } from '@app/common/decorators';
import { ENV_DEFAULT_ID } from '@app/connections/connection-registry.service';
import { CacheSimulatorService } from './cache-simulator.service';

@ApiTags('cache-simulator')
@Controller('cache-simulator')
export class CacheSimulatorController {
  constructor(private readonly simulator: CacheSimulatorService) {}

  @Get('snapshot')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.CACHE_SIZE_SIMULATOR)
  @ApiOperation({ summary: 'Sampled dataset size, growth and current memory state (Pro)' })
  @ApiQuery({ name: 'refresh', required: false, type: Boolean })
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false })
  getSnapshot(
    @Query('refresh') refresh?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<CacheSimulatorSnapshot> {
    return this.simulator.snapshot(connectionId || ENV_DEFAULT_ID, refresh === 'true');
  }
}
