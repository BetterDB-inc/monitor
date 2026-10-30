import { BadRequestException, Controller, Get, Post, Query, Param, HttpCode, HttpStatus, UseGuards, NotFoundException } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { AnomalyService } from './anomaly.service';
import { IncidentTimeline } from './incident-timeline';
import {
  AnomalyEvent,
  CorrelatedAnomalyGroup,
  BufferStats,
  AnomalySummary,
  MetricType,
  AnomalyPattern,
} from './types';
import { ReplicaDivergenceHistory } from './replication-divergence-detector';
import { LicenseGuard, RequiresFeature, Feature } from '@proprietary/licenses';
import { ConnectionId, CONNECTION_ID_HEADER } from '../../apps/api/src/common/decorators';

export function parseIncidentTime(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new BadRequestException(`${name} must be a positive epoch time in milliseconds`);
  }
  return parsed;
}

@Controller('anomaly')
export class AnomalyController {
  constructor(private readonly anomalyService: AnomalyService) {}

  @Get('events')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to filter by' })
  async getEvents(
    @ConnectionId() connectionId?: string,
    @Query('limit') limit?: string,
    @Query('metricType') metricType?: MetricType,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('activeOnly') activeOnly?: string,
  ): Promise<AnomalyEvent[]> {
    const parsedLimit = limit ? parseInt(limit, 10) : 100;
    const parsedStartTime = startTime ? parseInt(startTime, 10) : undefined;
    const parsedEndTime = endTime ? parseInt(endTime, 10) : undefined;
    // Active-incident feed (data-loss banner): return open incidents of any age,
    // so the 24h default window must NOT apply — an unresolved incident older
    // than 24h would otherwise be filtered out and the banner would go silent.
    const wantActiveOnly = activeOnly === 'true';

    // Otherwise default to the last 24 hours to include persisted data. Use ??
    // (not ||) so an explicit startTime of 0 is honored rather than treated as
    // "unset".
    const effectiveStartTime = wantActiveOnly
      ? parsedStartTime
      : parsedStartTime ?? (Date.now() - 24 * 60 * 60 * 1000);

    return this.anomalyService.getRecentAnomalies(
      effectiveStartTime,
      parsedEndTime,
      undefined,
      metricType,
      parsedLimit,
      connectionId,
      wantActiveOnly,
    );
  }

  @Get('groups')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to filter by' })
  async getGroups(
    @ConnectionId() connectionId?: string,
    @Query('limit') limit?: string,
    @Query('pattern') pattern?: AnomalyPattern,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ): Promise<CorrelatedAnomalyGroup[]> {
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    const parsedStartTime = startTime ? parseInt(startTime, 10) : undefined;
    const parsedEndTime = endTime ? parseInt(endTime, 10) : undefined;

    // If no time range specified, default to last 24 hours to include persisted data
    const defaultStartTime = parsedStartTime || (Date.now() - 24 * 60 * 60 * 1000);

    return this.anomalyService.getRecentCorrelatedGroups(
      defaultStartTime,
      parsedEndTime,
      pattern,
      parsedLimit,
      connectionId
    );
  }

  @Get('summary')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to filter by' })
  async getSummary(
    @ConnectionId() connectionId?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ): Promise<AnomalySummary> {
    const parsedStartTime = startTime ? parseInt(startTime, 10) : undefined;
    const parsedEndTime = endTime ? parseInt(endTime, 10) : undefined;

    // Default to last 24 hours to include persisted data
    const defaultStartTime = parsedStartTime || (Date.now() - 24 * 60 * 60 * 1000);

    return this.anomalyService.getSummary(defaultStartTime, parsedEndTime, connectionId);
  }

  @Get('buffers')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to filter by' })
  getBuffers(@ConnectionId() connectionId?: string): BufferStats[] {
    return this.anomalyService.getBufferStats(connectionId);
  }

  @Get('replication-divergence')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: true, description: 'Connection ID of the primary' })
  getReplicationDivergence(
    @ConnectionId({ required: true }) connectionId: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ): Promise<ReplicaDivergenceHistory[]> {
    const now = Date.now();
    const parsedEndTime = endTime ? parseInt(endTime, 10) : now;
    const parsedStartTime = startTime ? parseInt(startTime, 10) : parsedEndTime - 60 * 60 * 1000;
    return this.anomalyService.getReplicationDivergenceHistory(connectionId, parsedStartTime, parsedEndTime);
  }

  @Post('events/:id/resolve')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @HttpCode(HttpStatus.OK)
  async resolveEvent(@Param('id') id: string): Promise<{ success: boolean }> {
    const success = await this.anomalyService.resolveAnomaly(id);
    return { success };
  }

  @Post('groups/:correlationId/resolve')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @HttpCode(HttpStatus.OK)
  async resolveGroup(@Param('correlationId') correlationId: string): Promise<{ success: boolean }> {
    const success = await this.anomalyService.resolveGroup(correlationId);
    return { success };
  }

  @Post('events/clear-resolved')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @HttpCode(HttpStatus.OK)
  clearResolved(): { cleared: number } {
    const cleared = this.anomalyService.clearResolved();
    return { cleared };
  }

  @Get('incidents')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to filter by' })
  async getIncidents(
    @ConnectionId() connectionId?: string,
    @Query('limit') limit?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ): Promise<IncidentTimeline[]> {
    return this.anomalyService.getIncidentTimelines(
      connectionId,
      parseIncidentTime('startTime', startTime),
      parseIncidentTime('endTime', endTime),
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Get('incidents/:incidentId')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to filter by' })
  async getIncident(
    @Param('incidentId') incidentId: string,
    @ConnectionId() connectionId?: string,
    @Query('startTime') startTime?: string,
  ): Promise<IncidentTimeline> {
    const incident = await this.anomalyService.getIncidentTimeline(
      incidentId,
      connectionId,
      parseIncidentTime('startTime', startTime),
    );
    if (!incident) throw new NotFoundException(`Incident ${incidentId} not found`);
    return incident;
  }
}
