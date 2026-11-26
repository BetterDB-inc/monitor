import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  Param,
  HttpCode,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UseGuards,
  NotFoundException,
  Req,
} from '@nestjs/common';
import { ApiHeader, ApiOperation } from '@nestjs/swagger';
import { AnomalyService } from './anomaly.service';
import { PlacementService } from '../placement/placement.service';
import { IncidentTimeline } from './incident-timeline';
import {
  AnomalyEvent,
  ServedCorrelatedAnomalyGroup,
  BufferStats,
  AnomalySummary,
  FanoutCoverage,
  MetricType,
  AnomalyPattern,
} from './types';
import { ReplicaDivergenceHistory } from './replication-divergence-detector';
import { ServedHotShardDetail } from './hot-shard-detector';
import { TopologyDivergenceReport } from './topology-divergence-report';
import { TopologyDisagreementReport, TopologyFullCheckView } from './topology-full-check';
import { type RebalanceRunView, parseConfirmedMoves } from './slot-rebalance-run';
import type { RequestWithActor } from '../../apps/api/src/auth/guards/actor.guard';
import { LicenseGuard, RequiresFeature, Feature } from '@proprietary/licenses';
import { ConnectionId, CONNECTION_ID_HEADER } from '../../apps/api/src/common/decorators';
import { parseOptionalInt } from '../../apps/api/src/common/utils/parse-query-param';

function parseTimeRange(
  startTime: string | undefined,
  endTime: string | undefined,
): { parsedStartTime: number | undefined; parsedEndTime: number | undefined } {
  const parsedStartTime = parseOptionalInt(startTime, 'startTime');
  const parsedEndTime = parseOptionalInt(endTime, 'endTime');
  if (parsedStartTime !== undefined && parsedEndTime !== undefined && parsedStartTime > parsedEndTime) {
    throw new BadRequestException('startTime must not be after endTime');
  }
  return { parsedStartTime, parsedEndTime };
}

const MAX_INCIDENT_LIMIT = 1000;

function parseLimit(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (value.trim() === '' || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new BadRequestException('limit must be a positive integer');
  }
  return Math.min(parsed, MAX_INCIDENT_LIMIT);
}

@Controller('anomaly')
export class AnomalyController {
  constructor(
    private readonly anomalyService: AnomalyService,
    private readonly placement: PlacementService,
  ) {}

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
    const { parsedStartTime, parsedEndTime } = parseTimeRange(startTime, endTime);
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
  ): Promise<ServedCorrelatedAnomalyGroup[]> {
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    const { parsedStartTime, parsedEndTime } = parseTimeRange(startTime, endTime);

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
    const { parsedStartTime, parsedEndTime } = parseTimeRange(startTime, endTime);

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

  @Get('coverage')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to filter by' })
  getCoverage(@ConnectionId() connectionId?: string): FanoutCoverage[] {
    return this.anomalyService.getFanoutCoverage(connectionId);
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
    const { parsedStartTime, parsedEndTime } = parseTimeRange(startTime, endTime);
    const rangeEnd = parsedEndTime ?? Date.now();
    const rangeStart = parsedStartTime ?? rangeEnd - 60 * 60 * 1000;
    return this.anomalyService.getReplicationDivergenceHistory(connectionId, rangeStart, rangeEnd);
  }

  @Get('hot-shards')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: true, description: 'Connection ID of the cluster' })
  async getHotShards(
    @ConnectionId({ required: true }) connectionId: string,
  ): Promise<ServedHotShardDetail[]> {
    const shards = this.anomalyService.getHotShards(connectionId);
    return this.placement.withPlacementBlocker(connectionId, shards);
  }

  @Post('hot-shards/:shardId/rebalance')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @ApiOperation({ summary: 'Start the suggested slot rebalance for a hot shard' })
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: true, description: 'Connection ID of the cluster' })
  async runRebalance(
    @ConnectionId({ required: true }) connectionId: string,
    @Param('shardId') shardId: string,
    @Body() body: unknown,
    @Req() request: RequestWithActor,
  ): Promise<RebalanceRunView> {
    const confirmed = parseConfirmedMoves(body);
    if (!confirmed) {
      throw new BadRequestException('moves must list each target shard with its slot ranges');
    }
    const actor = request.actor;
    const result = await this.placement.runRebalance(connectionId, shardId, confirmed, {
      userId: actor?.userId ?? null,
      email: actor?.email ?? null,
    });
    switch (result.status) {
      case 'started':
        return result.run;
      case 'blocked':
        throw new ForbiddenException({ blockedBy: result.blockedBy });
      case 'changed':
        throw new ConflictException({ reason: result.reason, rebalance: result.rebalance });
      case 'refused':
        throw new BadGatewayException({ message: result.message });
    }
  }

  @Get('slot-rebalance')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @ApiOperation({ summary: 'Slot rebalances started from this monitor in the last hour' })
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: true, description: 'Connection ID of the cluster' })
  async getRebalanceRuns(
    @ConnectionId({ required: true }) connectionId: string,
    @Req() request: RequestWithActor,
  ): Promise<RebalanceRunView[]> {
    const runs = await this.anomalyService.followRebalanceRuns(connectionId);
    if (request.actor?.role === 'admin') return runs;
    return runs.map((run) => ({ ...run, startedBy: { ...run.startedBy, email: null } }));
  }

  @Post('slot-rebalance/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @ApiOperation({ summary: 'Cancel every slot migration on the source of a running rebalance' })
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: true, description: 'Connection ID of the cluster' })
  async cancelRebalance(
    @ConnectionId({ required: true }) connectionId: string,
    @Body() body: unknown,
  ): Promise<RebalanceRunView> {
    const sourceShardId = (body as { sourceShardId?: unknown } | null)?.sourceShardId;
    if (typeof sourceShardId !== 'string' || sourceShardId === '') {
      throw new BadRequestException('sourceShardId is required');
    }
    const result = await this.anomalyService.cancelRebalance(connectionId, sourceShardId);
    switch (result.status) {
      case 'cancelling':
        return result.run;
      case 'blocked':
        throw new ForbiddenException({ blockedBy: result.blockedBy });
      case 'not_running':
        throw new ConflictException({ reason: 'not_running' });
      case 'refused':
        throw new BadGatewayException({ message: result.message });
    }
  }

  @Get('topology-divergence')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @ApiOperation({
    summary: 'Last topology divergence round of the cluster',
    description:
      'Status ok means the views that answered were compared, not that the whole cluster agrees. ' +
      'Nodes listed in unanswered gave no view, and nodes that were not asked are not in the report.',
  })
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: true, description: 'Connection ID of the cluster' })
  getTopologyDivergence(@ConnectionId({ required: true }) connectionId: string): TopologyDivergenceReport {
    return this.anomalyService.getTopologyDivergence(connectionId);
  }

  @Get('topology-disagreements')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @ApiOperation({
    summary: 'Where the cluster views disagree, with one line per shard',
    description:
      'Counts are over the views that answered in the last round, not over every node: coverage says how many ' +
      'nodes there are, how many were asked and how many answered. Node lists are capped at 25, the counts are exact. ' +
      'fullCheck holds the last check that set out to ask every node, when one was run, with its own summary: ' +
      'the coverage of that summary says how many nodes it reached.',
  })
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: true, description: 'Connection ID of the cluster' })
  getTopologyDisagreements(@ConnectionId({ required: true }) connectionId: string): TopologyDisagreementReport {
    return this.anomalyService.getTopologyDisagreements(connectionId);
  }

  @Post('topology-disagreements/full-check')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Ask every node of the cluster for its view, once',
    description:
      'Reads the node list, starts the check and returns without waiting for the nodes to answer; progress and ' +
      'the result are in fullCheck of topology-disagreements. ' +
      'A request made while a check runs joins it. On a self-hosted install with user control on, only an admin ' +
      'can start it; a read-only member gets 403. Answers 404 for a connection that is not registered, 409 when ' +
      'the check cannot be run on the connection, 429 within 30 seconds of the last check and 503 when the node ' +
      'list cannot be read.',
  })
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: true, description: 'Connection ID of the cluster' })
  async startTopologyFullCheck(@ConnectionId({ required: true }) connectionId: string): Promise<TopologyFullCheckView> {
    const started = await this.anomalyService.startTopologyFullCheck(connectionId);
    if (started.result === 'unknown_connection') {
      throw new NotFoundException(`Connection ${connectionId} not found`);
    }
    if (started.result === 'unavailable') {
      throw new ConflictException({ statusCode: HttpStatus.CONFLICT, message: started.text, reason: started.reason });
    }
    if (started.result === 'too_soon') {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'The last full check ended less than 30 seconds ago',
          retryAt: started.retryAt,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (started.result === 'view_unreadable') {
      throw new ServiceUnavailableException('The node list of the cluster could not be read');
    }
    return this.anomalyService.getTopologyFullCheck(connectionId);
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
    const { parsedStartTime, parsedEndTime } = parseTimeRange(startTime, endTime);
    return this.anomalyService.getIncidentTimelines(
      connectionId,
      parsedStartTime,
      parsedEndTime,
      parseLimit(limit, 50),
    );
  }

  @Get('incidents/by-event/:anomalyId')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to filter by' })
  async getIncidentByEvent(
    @Param('anomalyId') anomalyId: string,
    @ConnectionId() connectionId?: string,
    @Query('at') at?: string,
  ): Promise<{ incidentId: string | null }> {
    const eventTime = parseOptionalInt(at, 'at');
    if (eventTime === undefined) throw new BadRequestException('at is required');
    return {
      incidentId: await this.anomalyService.findIncidentIdByEvent(
        anomalyId,
        eventTime,
        connectionId,
      ),
    };
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
      parseOptionalInt(startTime, 'startTime'),
    );
    if (!incident) throw new NotFoundException(`Incident ${incidentId} not found`);
    return incident;
  }
}
