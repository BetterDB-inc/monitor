import { BadRequestException, Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  Feature,
  type ScalingReadinessHistory,
  type ScalingReadinessSettings,
} from '@betterdb/shared';
import { LicenseGuard } from '@proprietary/licenses';
import { RequiresFeature } from '@proprietary/licenses/requires-feature.decorator';
import { ConnectionId } from '@app/common/decorators';
import { ENV_DEFAULT_ID } from '@app/connections/connection-registry.service';
import { ScalingReadinessProService } from './scaling-readiness-pro.service';
import { UpdateScalingReadinessSettingsDto } from './dto/update-scaling-readiness-settings.dto';

@ApiTags('scaling-readiness')
@Controller('scaling-readiness')
export class ScalingReadinessProController {
  constructor(private readonly service: ScalingReadinessProService) {}

  @Get('history')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.SCALING_READINESS_HISTORY)
  @ApiOperation({ summary: 'Stored scaling readiness scores (Pro)' })
  @ApiQuery({ name: 'from', required: true, type: Number })
  @ApiQuery({ name: 'to', required: true, type: Number })
  @ApiHeader({ name: 'x-connection-id', required: false })
  async getHistory(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @ConnectionId() connectionId?: string,
  ): Promise<ScalingReadinessHistory> {
    const fromMs = Number(from);
    const toMs = Number(to);
    if (!from || !to || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
      throw new BadRequestException('from and to must be millisecond timestamps with from <= to');
    }
    return this.service.getHistory(connectionId || ENV_DEFAULT_ID, fromMs, toMs);
  }

  @Get('settings')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.SCALING_READINESS_HISTORY)
  @ApiHeader({ name: 'x-connection-id', required: false })
  async getSettings(@ConnectionId() connectionId?: string): Promise<ScalingReadinessSettings> {
    return this.service.getSettings(connectionId || ENV_DEFAULT_ID);
  }

  @Put('settings')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.SCALING_READINESS_HISTORY)
  @ApiHeader({ name: 'x-connection-id', required: false })
  async updateSettings(
    @ConnectionId() connectionId?: string,
    @Body() body?: UpdateScalingReadinessSettingsDto,
  ): Promise<ScalingReadinessSettings> {
    return this.service.updateSettings(connectionId || ENV_DEFAULT_ID, body ?? {});
  }
}
