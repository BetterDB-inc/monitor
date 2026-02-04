import { Controller, Get, Post, Delete, Query, Param, HttpException, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiParam, ApiHeader } from '@nestjs/swagger';
import { MetricsService } from './metrics.service';
import { ClusterDiscoveryService, DiscoveredNode } from '../cluster/cluster-discovery.service';
import { ClusterMetricsService, NodeStats, ClusterSlowlogEntry, ClusterClientEntry, ClusterCommandlogEntry, SlotMigration } from '../cluster/cluster-metrics.service';
import { ConnectionId } from '../common/decorators';
import {
  InfoResponse,
  SlowLogEntry,
  CommandLogEntry,
  CommandLogType,
  LatencyEvent,
  LatencyHistoryEntry,
  LatencyHistogram,
  MemoryStats,
  ClientInfo,
  ClientFilters,
  AclLogEntry,
  RoleInfo,
  ClusterNode,
  SlotStats,
  ConfigGetResponse,
  SlowLogPatternAnalysis,
} from '../common/types/metrics.types';
import {
  SlowLogEntryDto,
  CommandLogEntryDto,
  LatencyEventDto,
  LatencyHistoryEntryDto,
  LatencyHistogramDto,
  MemoryStatsDto,
  ClientInfoDto,
  AclLogEntryDto,
  RoleInfoDto,
  ClusterNodeDto,
  SlotStatsMetricDto,
  GenericSuccessDto,
  LengthResponseDto,
  ReportResponseDto,
  KilledResponseDto,
  ConfigValueResponseDto,
  DbSizeResponseDto,
  LastSaveResponseDto,
  DiscoveredNodeDto,
  NodeStatsDto,
  ClusterSlowlogEntryDto,
  ClusterClientEntryDto,
  ClusterCommandlogEntryDto,
  SlotMigrationDto,
} from '../common/dto/metrics.dto';

@ApiTags('metrics')
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metricsService: MetricsService,
    private readonly clusterDiscoveryService: ClusterDiscoveryService,
    private readonly clusterMetricsService: ClusterMetricsService,
  ) {}

  @Get('info')
  @ApiOperation({ summary: 'Get parsed INFO response', description: 'Retrieve parsed Valkey/Redis INFO command output, optionally filtered by sections' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiQuery({ name: 'sections', required: false, description: 'Comma-separated list of INFO sections (server,clients,memory,etc.)' })
  @ApiResponse({ status: 200, description: 'INFO response retrieved successfully', schema: { type: 'object' } })
  @ApiResponse({ status: 500, description: 'Failed to get info' })
  async getInfo(
    @Query('sections') sections?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<InfoResponse> {
    try {
      const sectionArray = sections ? sections.split(',') : undefined;
      return await this.metricsService.getInfoParsed(sectionArray, connectionId);
    } catch (error) {
      throw new HttpException(
        `Failed to get info: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('slowlog')
  @ApiOperation({ summary: 'Get slowlog entries', description: 'Retrieve slowlog entries from Valkey/Redis' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiQuery({ name: 'count', required: false, description: 'Number of entries to return' })
  @ApiQuery({ name: 'excludeMonitor', required: false, description: 'Set to true to exclude BetterDB-Monitor commands' })
  @ApiQuery({ name: 'startTime', required: false, description: 'Filter entries after this Unix timestamp (seconds)' })
  @ApiQuery({ name: 'endTime', required: false, description: 'Filter entries before this Unix timestamp (seconds)' })
  @ApiResponse({ status: 200, description: 'Slowlog entries retrieved successfully', type: [SlowLogEntryDto] })
  @ApiResponse({ status: 500, description: 'Failed to get slowlog' })
  async getSlowLog(
    @Query('count') count?: string,
    @Query('excludeMonitor') excludeMonitor?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<SlowLogEntry[]> {
    try {
      const parsedCount = count ? parseInt(count, 10) : undefined;
      const excludeClientName = excludeMonitor === 'true' ? 'BetterDB-Monitor' : undefined;
      const parsedStartTime = startTime ? parseInt(startTime, 10) : undefined;
      const parsedEndTime = endTime ? parseInt(endTime, 10) : undefined;
      return await this.metricsService.getSlowLog(parsedCount, excludeClientName, parsedStartTime, parsedEndTime, connectionId);
    } catch (error) {
      throw new HttpException(
        `Failed to get slowlog: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('slowlog/length')
  @ApiOperation({ summary: 'Get slowlog length', description: 'Get the current number of entries in the slowlog' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiResponse({ status: 200, description: 'Slowlog length retrieved successfully', type: LengthResponseDto })
  @ApiResponse({ status: 500, description: 'Failed to get slowlog length' })
  async getSlowLogLength(@ConnectionId() connectionId?: string): Promise<{ length: number }> {
    try {
      const length = await this.metricsService.getSlowLogLength(connectionId);
      return { length };
    } catch (error) {
      throw new HttpException(
        `Failed to get slowlog length: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete('slowlog')
  @ApiOperation({ summary: 'Reset slowlog', description: 'Clear all entries from the slowlog' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiResponse({ status: 200, description: 'Slowlog reset successfully', type: GenericSuccessDto })
  @ApiResponse({ status: 500, description: 'Failed to reset slowlog' })
  async resetSlowLog(@ConnectionId() connectionId?: string): Promise<{ success: boolean }> {
    try {
      await this.metricsService.resetSlowLog(connectionId);
      return { success: true };
    } catch (error) {
      throw new HttpException(
        `Failed to reset slowlog: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('slowlog/patterns')
  @ApiOperation({ summary: 'Analyze slowlog patterns', description: 'Get aggregated analysis of slowlog command patterns' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiQuery({ name: 'count', required: false, description: 'Number of slowlog entries to analyze' })
  @ApiResponse({ status: 200, description: 'Slowlog pattern analysis retrieved successfully', schema: { type: 'object' } })
  @ApiResponse({ status: 500, description: 'Failed to analyze slowlog patterns' })
  async getSlowLogPatternAnalysis(
    @Query('count') count?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<SlowLogPatternAnalysis> {
    try {
      const parsedCount = count ? parseInt(count, 10) : undefined;
      return await this.metricsService.getSlowLogPatternAnalysis(parsedCount, connectionId);
    } catch (error) {
      throw new HttpException(
        `Failed to analyze slowlog patterns: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('commandlog')
  @ApiOperation({ summary: 'Get commandlog entries (Valkey 8.1+)', description: 'Retrieve commandlog entries from Valkey 8.1+' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiQuery({ name: 'count', required: false, description: 'Number of entries to return' })
  @ApiQuery({ name: 'type', required: false, enum: ['slow', 'large-request', 'large-reply'], description: 'Filter by commandlog type' })
  @ApiResponse({ status: 200, description: 'Commandlog entries retrieved successfully', type: [CommandLogEntryDto] })
  @ApiResponse({ status: 501, description: 'Commandlog not supported on this server version' })
  @ApiResponse({ status: 500, description: 'Failed to get commandlog' })
  async getCommandLog(
    @Query('count') count?: string,
    @Query('type') type?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<CommandLogEntry[]> {
    try {
      const parsedCount = count ? parseInt(count, 10) : undefined;
      const parsedType = type as CommandLogType | undefined;
      return await this.metricsService.getCommandLog(parsedCount, parsedType, connectionId);
    } catch (error) {
      const status = error instanceof Error && error.message.includes('not supported')
        ? HttpStatus.NOT_IMPLEMENTED
        : HttpStatus.INTERNAL_SERVER_ERROR;
      throw new HttpException(
        `Failed to get commandlog: ${error instanceof Error ? error.message : 'Unknown error'}`,
        status,
      );
    }
  }

  @Get('commandlog/length')
  @ApiOperation({ summary: 'Get commandlog length (Valkey 8.1+)', description: 'Get the number of entries in commandlog' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiQuery({ name: 'type', required: false, enum: ['slow', 'large-request', 'large-reply'], description: 'Filter by commandlog type' })
  @ApiResponse({ status: 200, description: 'Commandlog length retrieved successfully', type: LengthResponseDto })
  @ApiResponse({ status: 501, description: 'Commandlog not supported' })
  @ApiResponse({ status: 500, description: 'Failed to get commandlog length' })
  async getCommandLogLength(
    @Query('type') type?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<{ length: number }> {
    try {
      const parsedType = type as CommandLogType | undefined;
      const length = await this.metricsService.getCommandLogLength(parsedType, connectionId);
      return { length };
    } catch (error) {
      const status = error instanceof Error && error.message.includes('not supported')
        ? HttpStatus.NOT_IMPLEMENTED
        : HttpStatus.INTERNAL_SERVER_ERROR;
      throw new HttpException(
        `Failed to get commandlog length: ${error instanceof Error ? error.message : 'Unknown error'}`,
        status,
      );
    }
  }

  @Delete('commandlog')
  @ApiOperation({ summary: 'Reset commandlog (Valkey 8.1+)', description: 'Clear all commandlog entries' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiQuery({ name: 'type', required: false, enum: ['slow', 'large-request', 'large-reply'], description: 'Filter by commandlog type' })
  @ApiResponse({ status: 200, description: 'Commandlog reset successfully', type: GenericSuccessDto })
  @ApiResponse({ status: 501, description: 'Commandlog not supported' })
  @ApiResponse({ status: 500, description: 'Failed to reset commandlog' })
  async resetCommandLog(
    @Query('type') type?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<{ success: boolean }> {
    try {
      const parsedType = type as CommandLogType | undefined;
      await this.metricsService.resetCommandLog(parsedType, connectionId);
      return { success: true };
    } catch (error) {
      const status = error instanceof Error && error.message.includes('not supported')
        ? HttpStatus.NOT_IMPLEMENTED
        : HttpStatus.INTERNAL_SERVER_ERROR;
      throw new HttpException(
        `Failed to reset commandlog: ${error instanceof Error ? error.message : 'Unknown error'}`,
        status,
      );
    }
  }

  @Get('commandlog/patterns')
  @ApiOperation({ summary: 'Analyze commandlog patterns (Valkey 8.1+)', description: 'Get aggregated analysis of commandlog patterns' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiQuery({ name: 'count', required: false, description: 'Number of commandlog entries to analyze' })
  @ApiQuery({ name: 'type', required: false, enum: ['slow', 'large-request', 'large-reply'], description: 'Filter by commandlog type' })
  @ApiResponse({ status: 200, description: 'Commandlog pattern analysis retrieved successfully', schema: { type: 'object' } })
  @ApiResponse({ status: 501, description: 'Commandlog not supported' })
  @ApiResponse({ status: 500, description: 'Failed to analyze commandlog patterns' })
  async getCommandLogPatternAnalysis(
    @Query('count') count?: string,
    @Query('type') type?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<SlowLogPatternAnalysis> {
    try {
      const parsedCount = count ? parseInt(count, 10) : undefined;
      const parsedType = type as CommandLogType | undefined;
      return await this.metricsService.getCommandLogPatternAnalysis(
        parsedCount,
        parsedType,
        connectionId,
      );
    } catch (error) {
      const status =
        error instanceof Error && error.message.includes('not supported')
          ? HttpStatus.NOT_IMPLEMENTED
          : HttpStatus.INTERNAL_SERVER_ERROR;
      throw new HttpException(
        `Failed to analyze commandlog patterns: ${error instanceof Error ? error.message : 'Unknown error'}`,
        status,
      );
    }
  }

  @Get('latency/latest')
  @ApiOperation({ summary: 'Get latest latency events', description: 'Retrieve latest latency monitoring events' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiResponse({ status: 200, description: 'Latest latency events retrieved successfully', type: [LatencyEventDto] })
  @ApiResponse({ status: 500, description: 'Failed to get latest latency events' })
  async getLatestLatencyEvents(@ConnectionId() connectionId?: string): Promise<LatencyEvent[]> {
    try {
      return await this.metricsService.getLatestLatencyEvents(connectionId);
    } catch (error) {
      throw new HttpException(
        `Failed to get latest latency events: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('latency/history/:eventName')
  @ApiOperation({ summary: 'Get latency history for event', description: 'Retrieve historical latency data for a specific event' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiParam({ name: 'eventName', description: 'Name of the latency event' })
  @ApiResponse({ status: 200, description: 'Latency history retrieved successfully', type: [LatencyHistoryEntryDto] })
  @ApiResponse({ status: 500, description: 'Failed to get latency history' })
  async getLatencyHistory(
    @Param('eventName') eventName: string,
    @ConnectionId() connectionId?: string,
  ): Promise<LatencyHistoryEntry[]> {
    try {
      return await this.metricsService.getLatencyHistory(eventName, connectionId);
    } catch (error) {
      throw new HttpException(
        `Failed to get latency history: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('latency/histogram')
  @ApiOperation({ summary: 'Get latency histogram', description: 'Retrieve latency histogram for specified commands' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiQuery({ name: 'commands', required: false, description: 'Comma-separated list of commands' })
  @ApiResponse({ status: 200, description: 'Latency histogram retrieved successfully', schema: { type: 'object' } })
  @ApiResponse({ status: 500, description: 'Failed to get latency histogram' })
  async getLatencyHistogram(
    @Query('commands') commands?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<Record<string, LatencyHistogram>> {
    try {
      const commandArray = commands ? commands.split(',') : undefined;
      return await this.metricsService.getLatencyHistogram(commandArray, connectionId);
    } catch (error) {
      throw new HttpException(
        `Failed to get latency histogram: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('latency/doctor')
  @ApiOperation({ summary: 'Get LATENCY DOCTOR report', description: 'Retrieve automated latency analysis and recommendations' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiResponse({ status: 200, description: 'Latency doctor report retrieved successfully', type: ReportResponseDto })
  @ApiResponse({ status: 500, description: 'Failed to get latency doctor report' })
  async getLatencyDoctor(@ConnectionId() connectionId?: string): Promise<{ report: string }> {
    try {
      const report = await this.metricsService.getLatencyDoctor(connectionId);
      return { report };
    } catch (error) {
      throw new HttpException(
        `Failed to get latency doctor report: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete('latency')
  @ApiOperation({ summary: 'Reset latency events', description: 'Reset latency monitoring data for all or specific event' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiQuery({ name: 'eventName', required: false, description: 'Event name to reset (omit for all)' })
  @ApiResponse({ status: 200, description: 'Latency events reset successfully', type: GenericSuccessDto })
  @ApiResponse({ status: 500, description: 'Failed to reset latency events' })
  async resetLatencyEvents(
    @Query('eventName') eventName?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<{ success: boolean }> {
    try {
      await this.metricsService.resetLatencyEvents(eventName, connectionId);
      return { success: true };
    } catch (error) {
      throw new HttpException(
        `Failed to reset latency events: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('memory/stats')
  @ApiOperation({ summary: 'Get memory statistics', description: 'Retrieve detailed memory usage statistics' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiResponse({ status: 200, description: 'Memory statistics retrieved successfully', type: MemoryStatsDto })
  @ApiResponse({ status: 500, description: 'Failed to get memory stats' })
  async getMemoryStats(@ConnectionId() connectionId?: string): Promise<MemoryStats> {
    try {
      return await this.metricsService.getMemoryStats(connectionId);
    } catch (error) {
      throw new HttpException(
        `Failed to get memory stats: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('memory/doctor')
  @ApiOperation({ summary: 'Get MEMORY DOCTOR report', description: 'Retrieve automated memory analysis and recommendations' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiResponse({ status: 200, description: 'Memory doctor report retrieved successfully', type: ReportResponseDto })
  @ApiResponse({ status: 500, description: 'Failed to get memory doctor report' })
  async getMemoryDoctor(@ConnectionId() connectionId?: string): Promise<{ report: string }> {
    try {
      const report = await this.metricsService.getMemoryDoctor(connectionId);
      return { report };
    } catch (error) {
      throw new HttpException(
        `Failed to get memory doctor report: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('clients')
  @ApiOperation({ summary: 'Get connected clients', description: 'Retrieve list of currently connected clients' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiQuery({ name: 'type', required: false, enum: ['normal', 'master', 'replica', 'pubsub'], description: 'Filter by client type' })
  @ApiQuery({ name: 'id', required: false, description: 'Comma-separated list of client IDs' })
  @ApiResponse({ status: 200, description: 'Clients retrieved successfully', type: [ClientInfoDto] })
  @ApiResponse({ status: 500, description: 'Failed to get clients' })
  async getClients(
    @Query('type') type?: string,
    @Query('id') id?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<ClientInfo[]> {
    try {
      const filters: ClientFilters = {};
      if (type) filters.type = type as 'normal' | 'master' | 'replica' | 'pubsub';
      if (id) filters.id = id.split(',');
      return await this.metricsService.getClients(filters, connectionId);
    } catch (error) {
      throw new HttpException(
        `Failed to get clients: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('clients/:id')
  @ApiOperation({ summary: 'Get client by ID', description: 'Retrieve information about a specific client' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiParam({ name: 'id', description: 'Client ID' })
  @ApiResponse({ status: 200, description: 'Client retrieved successfully', type: ClientInfoDto })
  @ApiResponse({ status: 404, description: 'Client not found' })
  @ApiResponse({ status: 500, description: 'Failed to get client' })
  async getClientById(
    @Param('id') id: string,
    @ConnectionId() connectionId?: string,
  ): Promise<ClientInfo> {
    try {
      const client = await this.metricsService.getClientById(id, connectionId);
      if (!client) {
        throw new HttpException('Client not found', HttpStatus.NOT_FOUND);
      }
      return client;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        `Failed to get client: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete('clients')
  @ApiOperation({ summary: 'Kill client connections', description: 'Terminate one or more client connections' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiQuery({ name: 'type', required: false, enum: ['normal', 'master', 'replica', 'pubsub'], description: 'Filter by client type' })
  @ApiQuery({ name: 'id', required: false, description: 'Comma-separated list of client IDs' })
  @ApiResponse({ status: 200, description: 'Clients killed successfully', type: KilledResponseDto })
  @ApiResponse({ status: 500, description: 'Failed to kill client' })
  async killClient(
    @Query('type') type?: string,
    @Query('id') id?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<{ killed: number }> {
    try {
      const filters: ClientFilters = {};
      if (type) filters.type = type as 'normal' | 'master' | 'replica' | 'pubsub';
      if (id) filters.id = id.split(',');
      const killed = await this.metricsService.killClient(filters, connectionId);
      return { killed };
    } catch (error) {
      throw new HttpException(
        `Failed to kill client: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('acl/log')
  @ApiOperation({ summary: 'Get ACL log entries', description: 'Retrieve ACL security log entries' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiQuery({ name: 'count', required: false, description: 'Number of entries to return' })
  @ApiResponse({ status: 200, description: 'ACL log entries retrieved successfully', type: [AclLogEntryDto] })
  @ApiResponse({ status: 501, description: 'ACL not supported' })
  @ApiResponse({ status: 500, description: 'Failed to get ACL log' })
  async getAclLog(
    @Query('count') count?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<AclLogEntry[]> {
    try {
      const parsedCount = count ? parseInt(count, 10) : undefined;
      return await this.metricsService.getAclLog(parsedCount, connectionId);
    } catch (error) {
      const status = error instanceof Error && error.message.includes('not supported')
        ? HttpStatus.NOT_IMPLEMENTED
        : HttpStatus.INTERNAL_SERVER_ERROR;
      throw new HttpException(
        `Failed to get ACL log: ${error instanceof Error ? error.message : 'Unknown error'}`,
        status,
      );
    }
  }

  @Delete('acl/log')
  @ApiOperation({ summary: 'Reset ACL log', description: 'Clear all ACL log entries' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiResponse({ status: 200, description: 'ACL log reset successfully', type: GenericSuccessDto })
  @ApiResponse({ status: 501, description: 'ACL not supported' })
  @ApiResponse({ status: 500, description: 'Failed to reset ACL log' })
  async resetAclLog(@ConnectionId() connectionId?: string): Promise<{ success: boolean }> {
    try {
      await this.metricsService.resetAclLog(connectionId);
      return { success: true };
    } catch (error) {
      const status = error instanceof Error && error.message.includes('not supported')
        ? HttpStatus.NOT_IMPLEMENTED
        : HttpStatus.INTERNAL_SERVER_ERROR;
      throw new HttpException(
        `Failed to reset ACL log: ${error instanceof Error ? error.message : 'Unknown error'}`,
        status,
      );
    }
  }

  @Get('role')
  @ApiOperation({ summary: 'Get replication role', description: 'Retrieve replication role and status information' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiResponse({ status: 200, description: 'Role information retrieved successfully', type: RoleInfoDto })
  @ApiResponse({ status: 500, description: 'Failed to get role' })
  async getRole(@ConnectionId() connectionId?: string): Promise<RoleInfo> {
    try {
      return await this.metricsService.getRole(connectionId);
    } catch (error) {
      throw new HttpException(
        `Failed to get role: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('cluster/info')
  @ApiOperation({ summary: 'Get cluster info', description: 'Retrieve cluster information and status' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiResponse({ status: 200, description: 'Cluster info retrieved successfully', schema: { type: 'object' } })
  @ApiResponse({ status: 500, description: 'Failed to get cluster info' })
  async getClusterInfo(@ConnectionId() connectionId?: string): Promise<Record<string, string>> {
    try {
      return await this.metricsService.getClusterInfo(connectionId);
    } catch (error) {
      throw new HttpException(
        `Failed to get cluster info: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('cluster/nodes')
  @ApiOperation({ summary: 'Get cluster nodes', description: 'Retrieve information about all cluster nodes' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiResponse({ status: 200, description: 'Cluster nodes retrieved successfully', type: [ClusterNodeDto] })
  @ApiResponse({ status: 500, description: 'Failed to get cluster nodes' })
  async getClusterNodes(@ConnectionId() connectionId?: string): Promise<ClusterNode[]> {
    try {
      return await this.metricsService.getClusterNodes(connectionId);
    } catch (error) {
      throw new HttpException(
        `Failed to get cluster nodes: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('cluster/slot-stats')
  @ApiOperation({ summary: 'Get cluster slot statistics', description: 'Retrieve per-slot statistics for cluster' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiQuery({ name: 'orderBy', required: false, enum: ['key-count', 'cpu-usec'], description: 'Sort order' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of slots to return' })
  @ApiResponse({ status: 200, description: 'Cluster slot stats retrieved successfully', schema: { type: 'object' } })
  @ApiResponse({ status: 501, description: 'Cluster slot stats not supported' })
  @ApiResponse({ status: 500, description: 'Failed to get cluster slot stats' })
  async getClusterSlotStats(
    @Query('orderBy') orderBy?: string,
    @Query('limit') limit?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<SlotStats> {
    try {
      const parsedOrderBy = orderBy as 'key-count' | 'cpu-usec' | undefined;
      const parsedLimit = limit ? parseInt(limit, 10) : undefined;
      return await this.metricsService.getClusterSlotStats(parsedOrderBy, parsedLimit, connectionId);
    } catch (error) {
      const status = error instanceof Error && error.message.includes('not supported')
        ? HttpStatus.NOT_IMPLEMENTED
        : HttpStatus.INTERNAL_SERVER_ERROR;
      throw new HttpException(
        `Failed to get cluster slot stats: ${error instanceof Error ? error.message : 'Unknown error'}`,
        status,
      );
    }
  }

  @Get('config/:parameter')
  @ApiOperation({ summary: 'Get config parameter', description: 'Retrieve value of a specific configuration parameter' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiParam({ name: 'parameter', description: 'Configuration parameter name' })
  @ApiResponse({ status: 200, description: 'Config value retrieved successfully', type: ConfigValueResponseDto })
  @ApiResponse({ status: 500, description: 'Failed to get config value' })
  async getConfigValue(
    @Param('parameter') parameter: string,
    @ConnectionId() connectionId?: string,
  ): Promise<{ value: string | null }> {
    try {
      const value = await this.metricsService.getConfigValue(parameter, connectionId);
      return { value };
    } catch (error) {
      throw new HttpException(
        `Failed to get config value: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('config')
  @ApiOperation({ summary: 'Get config values', description: 'Retrieve configuration values matching pattern' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiQuery({ name: 'pattern', required: false, description: 'Glob pattern for config keys (default: *)' })
  @ApiResponse({ status: 200, description: 'Config values retrieved successfully', schema: { type: 'object' } })
  @ApiResponse({ status: 500, description: 'Failed to get config values' })
  async getConfigValues(
    @Query('pattern') pattern: string = '*',
    @ConnectionId() connectionId?: string,
  ): Promise<ConfigGetResponse> {
    try {
      return await this.metricsService.getConfigValues(pattern, connectionId);
    } catch (error) {
      throw new HttpException(
        `Failed to get config values: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('dbsize')
  @ApiOperation({ summary: 'Get database size', description: 'Retrieve the number of keys in the current database' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiResponse({ status: 200, description: 'Database size retrieved successfully', type: DbSizeResponseDto })
  @ApiResponse({ status: 500, description: 'Failed to get database size' })
  async getDbSize(@ConnectionId() connectionId?: string): Promise<{ size: number }> {
    try {
      const size = await this.metricsService.getDbSize(connectionId);
      return { size };
    } catch (error) {
      throw new HttpException(
        `Failed to get database size: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('lastsave')
  @ApiOperation({ summary: 'Get last save time', description: 'Retrieve Unix timestamp of last successful RDB save' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiResponse({ status: 200, description: 'Last save time retrieved successfully', type: LastSaveResponseDto })
  @ApiResponse({ status: 500, description: 'Failed to get last save time' })
  async getLastSaveTime(@ConnectionId() connectionId?: string): Promise<{ timestamp: number }> {
    try {
      const timestamp = await this.metricsService.getLastSaveTime(connectionId);
      return { timestamp };
    } catch (error) {
      throw new HttpException(
        `Failed to get last save time: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // New cluster endpoints

  @Get('cluster/nodes/discover')
  @ApiOperation({ summary: 'Discover cluster nodes', description: 'Discover and return all nodes in the cluster' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiResponse({ status: 200, description: 'Cluster nodes discovered successfully', type: [DiscoveredNodeDto] })
  @ApiResponse({ status: 500, description: 'Failed to discover cluster nodes' })
  async discoverClusterNodes(@ConnectionId() connectionId?: string): Promise<DiscoveredNode[]> {
    try {
      return await this.clusterDiscoveryService.discoverNodes(connectionId);
    } catch (error) {
      throw new HttpException(
        `Failed to discover cluster nodes: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('cluster/nodes/:nodeId/info')
  @ApiOperation({ summary: 'Get INFO from specific node', description: 'Retrieve INFO command output from a specific cluster node' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiParam({ name: 'nodeId', description: 'Node ID' })
  @ApiResponse({ status: 200, description: 'Node INFO retrieved successfully', schema: { type: 'object' } })
  @ApiResponse({ status: 500, description: 'Failed to get node info' })
  async getNodeInfo(
    @Param('nodeId') nodeId: string,
    @ConnectionId() connectionId?: string,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.clusterMetricsService.getNodeInfo(nodeId);
    } catch (error) {
      throw new HttpException(
        `Failed to get node info: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('cluster/node-stats')
  @ApiOperation({ summary: 'Get comparative stats for all nodes', description: 'Retrieve performance and resource metrics for all cluster nodes' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiResponse({ status: 200, description: 'Cluster node stats retrieved successfully', type: [NodeStatsDto] })
  @ApiResponse({ status: 500, description: 'Failed to get cluster node stats' })
  async getClusterNodeStats(@ConnectionId() connectionId?: string): Promise<NodeStats[]> {
    try {
      return await this.clusterMetricsService.getClusterNodeStats();
    } catch (error) {
      throw new HttpException(
        `Failed to get cluster node stats: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('cluster/slowlog')
  @ApiOperation({ summary: 'Get slowlog aggregated from all cluster nodes', description: 'Retrieve slowlog entries from all nodes, merged and sorted' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of entries to return (1-10000, default: 100)' })
  @ApiResponse({ status: 200, description: 'Cluster slowlog retrieved successfully', type: [ClusterSlowlogEntryDto] })
  @ApiResponse({ status: 400, description: 'Invalid limit parameter' })
  @ApiResponse({ status: 500, description: 'Failed to get cluster slowlog' })
  async getClusterSlowlog(
    @Query('limit') limit?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<ClusterSlowlogEntry[]> {
    try {
      const parsedLimit = limit ? parseInt(limit, 10) : 100;

      if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 10000) {
        throw new HttpException(
          'Invalid limit parameter: must be a number between 1 and 10000',
          HttpStatus.BAD_REQUEST,
        );
      }

      return await this.clusterMetricsService.getClusterSlowlog(parsedLimit);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to get cluster slowlog: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('cluster/clients')
  @ApiOperation({ summary: 'Get client list from all cluster nodes', description: 'Retrieve connected clients from all nodes' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiResponse({ status: 200, description: 'Cluster clients retrieved successfully', type: [ClusterClientEntryDto] })
  @ApiResponse({ status: 500, description: 'Failed to get cluster clients' })
  async getClusterClients(@ConnectionId() connectionId?: string): Promise<ClusterClientEntry[]> {
    try {
      return await this.clusterMetricsService.getClusterClients();
    } catch (error) {
      throw new HttpException(
        `Failed to get cluster clients: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('cluster/commandlog')
  @ApiOperation({ summary: 'Get commandlog from all cluster nodes (Valkey 8.1+)', description: 'Retrieve commandlog entries from all nodes, merged and sorted' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiQuery({ name: 'type', required: false, enum: ['slow', 'large-request', 'large-reply'], description: 'Filter by commandlog type' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of entries to return (1-10000, default: 100)' })
  @ApiResponse({ status: 200, description: 'Cluster commandlog retrieved successfully', type: [ClusterCommandlogEntryDto] })
  @ApiResponse({ status: 400, description: 'Invalid parameters' })
  @ApiResponse({ status: 500, description: 'Failed to get cluster commandlog' })
  async getClusterCommandlog(
    @Query('type') type?: string,
    @Query('limit') limit?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<ClusterCommandlogEntry[]> {
    try {
      const validTypes = ['slow', 'large-request', 'large-reply'];
      const parsedType = (type as CommandLogType) || 'slow';

      if (type && !validTypes.includes(parsedType)) {
        throw new HttpException(
          `Invalid type parameter: must be one of ${validTypes.join(', ')}`,
          HttpStatus.BAD_REQUEST,
        );
      }

      const parsedLimit = limit ? parseInt(limit, 10) : 100;

      if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 10000) {
        throw new HttpException(
          'Invalid limit parameter: must be a number between 1 and 10000',
          HttpStatus.BAD_REQUEST,
        );
      }

      return await this.clusterMetricsService.getClusterCommandlog(parsedType, parsedLimit);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to get cluster commandlog: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('cluster/migrations')
  @ApiOperation({ summary: 'Get active slot migrations', description: 'Retrieve information about ongoing slot migrations in the cluster' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiResponse({ status: 200, description: 'Slot migrations retrieved successfully', type: [SlotMigrationDto] })
  @ApiResponse({ status: 500, description: 'Failed to get slot migrations' })
  async getSlotMigrations(@ConnectionId() connectionId?: string): Promise<SlotMigration[]> {
    try {
      return await this.clusterMetricsService.getSlotMigrations();
    } catch (error) {
      throw new HttpException(
        `Failed to get slot migrations: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
