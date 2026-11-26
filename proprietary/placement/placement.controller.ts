import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation } from '@nestjs/swagger';
import { PLACEMENT_MODES, type PlacementMode, type PlacementStatus } from '@betterdb/shared';
import { LicenseGuard, RequiresFeature, Feature } from '@proprietary/licenses';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { ConnectionId, CONNECTION_ID_HEADER } from '@app/common/decorators';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { ValidateInstanceIdPipe, mapMcpError } from '@app/mcp/mcp-helpers';
import { PlacementModeError, PlacementService } from './placement.service';

function parseMode(body: unknown): PlacementMode | null {
  if (typeof body !== 'object' || body === null) return null;
  const mode = (body as { mode?: unknown }).mode;
  return PLACEMENT_MODES.includes(mode as PlacementMode) ? (mode as PlacementMode) : null;
}

@Controller('anomaly')
export class PlacementController {
  constructor(private readonly placement: PlacementService) {}

  @Get('placement')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @ApiOperation({ summary: 'Placement mode, support verdict and per-shard balance of a cluster' })
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: true, description: 'Connection ID of the cluster' })
  getStatus(@ConnectionId({ required: true }) connectionId: string): Promise<PlacementStatus> {
    return this.placement.getStatus(connectionId);
  }

  @Put('placement/mode')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @ApiOperation({ summary: 'Set the placement mode of a cluster (Observe or Recommend)' })
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: true, description: 'Connection ID of the cluster' })
  async setMode(
    @ConnectionId({ required: true }) connectionId: string,
    @Body() body: unknown,
  ): Promise<PlacementStatus> {
    const mode = parseMode(body);
    if (!mode) {
      throw new BadRequestException(`mode must be one of: ${PLACEMENT_MODES.join(', ')}`);
    }
    try {
      return await this.placement.setMode(connectionId, mode);
    } catch (err) {
      if (err instanceof PlacementModeError) {
        throw new BadRequestException({ message: err.message, blockedBy: err.blockedBy });
      }
      throw err;
    }
  }
}

@Controller('mcp')
@UseGuards(AgentTokenGuard, LicenseGuard)
@RequiresFeature(Feature.ANOMALY_DETECTION)
export class McpPlacementController {
  private readonly logger = new Logger(McpPlacementController.name);

  constructor(
    private readonly placement: PlacementService,
    private readonly registry: ConnectionRegistry,
  ) {}

  @Get('instance/:id/placement')
  async getStatus(@Param('id', ValidateInstanceIdPipe) id: string): Promise<PlacementStatus> {
    try {
      this.registry.get(id);
      return await this.placement.getStatus(id);
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get placement status');
    }
  }
}
