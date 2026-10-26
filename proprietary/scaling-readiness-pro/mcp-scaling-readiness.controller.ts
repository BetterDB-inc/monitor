import { Controller, Get, Logger, Param, Query, UseGuards } from '@nestjs/common';
import { Feature, type ScalingReadinessHistory } from '@betterdb/shared';
import { LicenseGuard } from '@proprietary/licenses';
import { RequiresFeature } from '@proprietary/licenses/requires-feature.decorator';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { DAY_MS, ValidateInstanceIdPipe, mapMcpError, resolveTimeRange } from '@app/mcp/mcp-helpers';
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
  async getHistory(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ): Promise<ScalingReadinessHistory> {
    const range = resolveTimeRange(startTime, endTime, MCP_READINESS_DEFAULT_LOOKBACK_MS, MCP_READINESS_MAX_SPAN_MS);
    try {
      this.registry.get(id);
      return await this.service.getHistory(id, range.from, range.to);
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get scaling readiness history');
    }
  }
}
