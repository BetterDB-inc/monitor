import { Controller, Get, Logger, Param, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Feature, type ScalingReadinessHistory } from '@betterdb/shared';
import { LicenseGuard } from '@proprietary/licenses';
import { RequiresFeature } from '@proprietary/licenses/requires-feature.decorator';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import {
  DAY_MS,
  type SamplingInfo,
  ValidateInstanceIdPipe,
  downsampleEvenly,
  evenSampling,
  mapMcpError,
  parseMaxPoints,
  resolveTimeRange,
} from '@app/mcp/mcp-helpers';
import { ScalingReadinessProService } from './scaling-readiness-pro.service';

export const MCP_READINESS_DEFAULT_LOOKBACK_MS = 7 * DAY_MS;
export const MCP_READINESS_MAX_SPAN_MS = 90 * DAY_MS;

@Controller('mcp')
@UseGuards(AgentTokenGuard, LicenseGuard)
@RequiresFeature(Feature.SCALING_READINESS_HISTORY)
export class McpScalingReadinessController {
  private readonly logger = new Logger(McpScalingReadinessController.name);

  constructor(
    private readonly service: ScalingReadinessProService,
    private readonly registry: ConnectionRegistry,
  ) {}

  @Get('instance/:id/scaling-readiness/history')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async getHistory(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('maxPoints') maxPoints?: string,
  ): Promise<ScalingReadinessHistory & { sampling: SamplingInfo }> {
    const budget = parseMaxPoints(maxPoints);
    const range = resolveTimeRange(startTime, endTime, MCP_READINESS_DEFAULT_LOOKBACK_MS, MCP_READINESS_MAX_SPAN_MS);
    try {
      this.registry.get(id);
      const history = await this.service.getHistory(id, range.from, range.to);
      const points = downsampleEvenly(history.points, budget);
      return { ...history, points, sampling: evenSampling(history.points.length, points.length, budget) };
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get scaling readiness history');
    }
  }
}
