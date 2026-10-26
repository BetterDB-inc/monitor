import { Controller, Get, Logger, Param, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { CveDatasetStatus, CveScanResult, FleetSummaryResponse, ScalingReadiness } from '@betterdb/shared';
import { AgentTokenGuard } from '../common/guards/agent-token.guard';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { CveService } from '../cve/cve.service';
import { FleetService } from '../fleet/fleet.service';
import { ScalingReadinessService } from '../scaling-readiness/scaling-readiness.service';
import { ValidateInstanceIdPipe, mapMcpError } from './mcp-helpers';

/**
 * Read-only MCP views over the community scaling-readiness, CVE and fleet
 * services. Each route is a thin pass-through to the same service method the
 * REST controller calls, so agents and the UI always see identical numbers.
 */
@Controller('mcp')
@UseGuards(AgentTokenGuard)
export class McpInsightsController {
  private readonly logger = new Logger(McpInsightsController.name);

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly scalingReadinessService: ScalingReadinessService,
    private readonly cveService: CveService,
    private readonly fleetService: FleetService,
  ) {}

  @Get('instance/:id/scaling-readiness')
  async getScalingReadiness(
    @Param('id', ValidateInstanceIdPipe) id: string,
  ): Promise<ScalingReadiness> {
    try {
      this.registry.get(id);
      return await this.scalingReadinessService.compute(id);
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to compute scaling readiness');
    }
  }

  @Get('instance/:id/cve')
  async getCveExposure(
    @Param('id', ValidateInstanceIdPipe) id: string,
  ): Promise<{ scan: CveScanResult; dataset: CveDatasetStatus }> {
    try {
      this.registry.get(id);
      const [scan, dataset] = await Promise.all([
        this.cveService.getScan(id),
        this.cveService.getDataset(),
      ]);
      return { scan, dataset };
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get CVE exposure');
    }
  }

  @Get('fleet/summary')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  async getFleetSummary(): Promise<FleetSummaryResponse> {
    try {
      return await this.fleetService.getSummary();
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get fleet summary');
    }
  }
}
