import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { LicenseGuard } from '@proprietary/licenses';
import { RequiresFeature } from '@proprietary/licenses/requires-feature.decorator';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { ValidateInstanceIdPipe, safeLimit, safeParseInt } from '@app/mcp/mcp-helpers';
import { KeyAnalyticsService } from './key-analytics.service';

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
}
