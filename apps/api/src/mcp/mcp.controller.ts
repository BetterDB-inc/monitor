import { Controller, Get, Post, Body, Param, Query, HttpException, HttpStatus, UseGuards, Optional, Inject, BadRequestException, PipeTransform, Injectable, Logger } from '@nestjs/common';
import { ANOMALY_SERVICE } from '@betterdb/shared';
import { UsageTelemetryService } from '../telemetry/usage-telemetry.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { AgentTokenGuard } from '../common/guards/agent-token.guard';
import { MetricsService } from '../metrics/metrics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { ClientAnalyticsAnalysisService } from '../client-analytics/client-analytics-analysis.service';
import { ClusterDiscoveryService } from '../cluster/cluster-discovery.service';
import { ClusterMetricsService } from '../cluster/cluster-metrics.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';

const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const EVENT_NAME_RE = /^[a-zA-Z0-9_.-]+$/;
const VALID_ORDER_BY = new Set(['key-count', 'cpu-usec']);
const MAX_LIMIT = 10000;

@Injectable()
class ValidateInstanceIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!INSTANCE_ID_RE.test(value)) {
      throw new BadRequestException('Invalid instance ID');
    }
    return value;
  }
}

function safeParseInt(value: string | undefined, defaultValue: number): number;
function safeParseInt(value: string | undefined, defaultValue?: undefined): number | undefined;
function safeParseInt(value: string | undefined, defaultValue?: number): number | undefined {
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) return defaultValue;
  return parsed;
}

/** Parse and cap a limit/count query param */
function safeLimit(value: string | undefined, defaultValue: number): number {
  return Math.max(1, Math.min(safeParseInt(value, defaultValue), MAX_LIMIT));
}

/** Convert ms timestamp query param to seconds for commandlog service */
function msToSeconds(value: string | undefined): number | undefined {
  const ms = safeParseInt(value);
  if (ms === undefined || ms < 0) return undefined;
  return Math.floor(ms / 1000);
}

@Controller('mcp')
@UseGuards(AgentTokenGuard)
export class McpController {
  private readonly logger = new Logger(McpController.name);
  private readonly anomalyService: any;

  private readonly telemetryService: UsageTelemetryService | null;

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly metricsService: MetricsService,
    private readonly commandLogAnalyticsService: CommandLogAnalyticsService,
    private readonly clientAnalyticsAnalysisService: ClientAnalyticsAnalysisService,
    private readonly clusterDiscoveryService: ClusterDiscoveryService,
    private readonly clusterMetricsService: ClusterMetricsService,
    @Inject('STORAGE_CLIENT') private readonly storageClient: StoragePort,
    @Optional() @Inject(ANOMALY_SERVICE) anomalyService?: any,
    @Optional() telemetryService?: UsageTelemetryService,
  ) {
    this.anomalyService = anomalyService ?? null;
    this.telemetryService = telemetryService ?? null;
  }

  @Get('instances')
  async listInstances() {
    const list = this.registry.list();
    return {
      instances: list.map((c) => ({
        id: c.id,
        name: c.name,
        host: c.host,
        port: c.port,
        isDefault: c.isDefault,
        isConnected: c.isConnected,
        capabilities: c.capabilities,
      })),
    };
  }

  @Get('instance/:id/info')
  async getInfo(@Param('id', ValidateInstanceIdPipe) id: string) {
    try {
      const client = this.registry.get(id);
      const info = await client.getInfoParsed();
      return info;
    } catch (error) {
      this.logger.error(`Failed to get info for ${id}`, error instanceof Error ? error.stack : error);
      throw new HttpException('Failed to get info', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('instance/:id/slowlog')
  async getSlowlog(@Param('id', ValidateInstanceIdPipe) id: string, @Query('count') count?: string) {
    try {
      const client = this.registry.get(id);
      const parsedCount = safeLimit(count, 25);
      return await client.getSlowLog(parsedCount);
    } catch (error) {
      this.logger.error(`Failed to get slowlog for ${id}`, error instanceof Error ? error.stack : error);
      throw new HttpException('Failed to get slowlog', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('instance/:id/latency')
  async getLatency(@Param('id', ValidateInstanceIdPipe) id: string) {
    try {
      const client = this.registry.get(id);
      return await client.getLatestLatencyEvents();
    } catch (error) {
      this.logger.error(`Failed to get latency for ${id}`, error instanceof Error ? error.stack : error);
      throw new HttpException('Failed to get latency', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('instance/:id/memory')
  async getMemory(@Param('id', ValidateInstanceIdPipe) id: string) {
    try {
      const client = this.registry.get(id);
      const [doctor, stats] = await Promise.all([
        client.getMemoryDoctor(),
        client.getMemoryStats(),
      ]);
      return { doctor, stats };
    } catch (error) {
      this.logger.error(`Failed to get memory for ${id}`, error instanceof Error ? error.stack : error);
      throw new HttpException('Failed to get memory diagnostics', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('instance/:id/commandlog')
  async getCommandlog(@Param('id', ValidateInstanceIdPipe) id: string, @Query('count') count?: string) {
    try {
      const client = this.registry.get(id);
      const capabilities = client.getCapabilities();
      if (!capabilities.hasCommandLog) {
        return { entries: [], note: 'COMMANDLOG not supported on this database version' };
      }
      const parsedCount = safeLimit(count, 25);
      return await client.getCommandLog(parsedCount);
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      if (msg.includes('unknown command') || msg.includes('COMMANDLOG')) {
        return { entries: [], note: 'COMMANDLOG not available on this instance' };
      }
      this.logger.error(`Failed to get commandlog for ${id}`, error instanceof Error ? error.stack : error);
      throw new HttpException('Failed to get commandlog', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('instance/:id/clients')
  async getClients(@Param('id', ValidateInstanceIdPipe) id: string) {
    try {
      const client = this.registry.get(id);
      return await client.getClients();
    } catch (error) {
      this.logger.error(`Failed to get clients for ${id}`, error instanceof Error ? error.stack : error);
      throw new HttpException('Failed to get clients', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('instance/:id/history/slowlog-patterns')
  async getSlowlogPatterns(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('limit') limit?: string,
  ) {
    try {
      const parsedLimit = limit !== undefined ? safeLimit(limit, MAX_LIMIT) : undefined;
      return await this.metricsService.getSlowLogPatternAnalysis(parsedLimit, id);
    } catch (error) {
      this.logger.error(`Failed to get slowlog patterns for ${id}`, error instanceof Error ? error.stack : error);
      throw new HttpException('Failed to get slowlog patterns', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('instance/:id/history/commandlog')
  async getCommandlogHistory(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('command') command?: string,
    @Query('minDuration') minDuration?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      return await this.commandLogAnalyticsService.getStoredCommandLog({
        startTime: msToSeconds(startTime),
        endTime: msToSeconds(endTime),
        command,
        minDuration: safeParseInt(minDuration),
        limit: safeLimit(limit, 100),
        offset: 0,
        connectionId: id,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      if (msg.includes('unknown command') || msg.includes('COMMANDLOG')) {
        return { entries: [], note: 'COMMANDLOG not available on this instance' };
      }
      this.logger.error(`Failed to get commandlog history for ${id}`, error instanceof Error ? error.stack : error);
      throw new HttpException('Failed to get commandlog history', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('instance/:id/history/commandlog-patterns')
  async getCommandlogPatterns(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      return await this.commandLogAnalyticsService.getStoredCommandLogPatternAnalysis({
        startTime: msToSeconds(startTime),
        endTime: msToSeconds(endTime),
        limit: safeLimit(limit, 500),
        connectionId: id,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      if (msg.includes('unknown command') || msg.includes('COMMANDLOG')) {
        return { entries: [], note: 'COMMANDLOG not available on this instance' };
      }
      this.logger.error(`Failed to get commandlog patterns for ${id}`, error instanceof Error ? error.stack : error);
      throw new HttpException('Failed to get commandlog patterns', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // License gating is handled at runtime: anomalyService is only injected when
  // the proprietary anomaly module is available, and the null check below returns
  // a graceful "not available" response in community mode.
  @Get('instance/:id/history/anomalies')
  async getAnomalies(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('limit') limit?: string,
    @Query('metricType') metricType?: string,
    @Query('startTime') startTime?: string,
  ) {
    if (!this.anomalyService || !this.anomalyService.getRecentAnomalies) {
      return { events: [], note: 'Anomaly detection is not available (requires BetterDB Pro)' };
    }
    try {
      const parsedLimit = safeLimit(limit, 100);
      const parsedStartTime = safeParseInt(startTime, Date.now() - 24 * 60 * 60 * 1000);
      return await this.anomalyService.getRecentAnomalies(
        parsedStartTime,
        undefined,
        undefined,
        metricType || undefined,
        parsedLimit,
        id,
      );
    } catch (error) {
      this.logger.error(`Failed to get anomalies for ${id}`, error instanceof Error ? error.stack : error);
      throw new HttpException('Failed to get anomalies', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('instance/:id/history/client-activity')
  async getClientActivity(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('bucketSizeMinutes') bucketSizeMinutes?: string,
  ) {
    try {
      return await this.clientAnalyticsAnalysisService.getActivityTimeline(
        {
          startTime: safeParseInt(startTime),
          endTime: safeParseInt(endTime),
          bucketSizeMinutes: safeParseInt(bucketSizeMinutes),
        },
        id,
      );
    } catch (error) {
      this.logger.error(`Failed to get client activity for ${id}`, error instanceof Error ? error.stack : error);
      throw new HttpException('Failed to get client activity', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('instance/:id/cluster/nodes')
  async getClusterNodes(@Param('id', ValidateInstanceIdPipe) id: string) {
    try {
      return await this.clusterDiscoveryService.discoverNodes(id);
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      if (msg.includes('CLUSTERDOWN') || msg.includes('cluster mode')) {
        return { error: 'not_cluster', message: 'This instance is not running in cluster mode.' };
      }
      this.logger.error(`Failed to get cluster nodes for ${id}`, error instanceof Error ? error.stack : error);
      throw new HttpException('Failed to get cluster nodes', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('instance/:id/cluster/node-stats')
  async getClusterNodeStats(@Param('id', ValidateInstanceIdPipe) id: string) {
    try {
      return await this.clusterMetricsService.getClusterNodeStats(id);
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      if (msg.includes('CLUSTERDOWN') || msg.includes('cluster mode')) {
        return { error: 'not_cluster', message: 'This instance is not running in cluster mode.' };
      }
      this.logger.error(`Failed to get cluster node stats for ${id}`, error instanceof Error ? error.stack : error);
      throw new HttpException('Failed to get cluster node stats', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('instance/:id/cluster/slowlog')
  async getClusterSlowlog(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('limit') limit?: string,
  ) {
    try {
      const parsedLimit = safeLimit(limit, 100);
      return await this.clusterMetricsService.getClusterSlowlog(parsedLimit, id);
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      if (msg.includes('CLUSTERDOWN') || msg.includes('cluster mode')) {
        return { error: 'not_cluster', message: 'This instance is not running in cluster mode.' };
      }
      this.logger.error(`Failed to get cluster slowlog for ${id}`, error instanceof Error ? error.stack : error);
      throw new HttpException('Failed to get cluster slowlog', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('instance/:id/cluster/slot-stats')
  async getClusterSlotStats(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('orderBy') orderBy?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      const parsedOrderBy = (orderBy && VALID_ORDER_BY.has(orderBy))
        ? (orderBy as 'key-count' | 'cpu-usec')
        : 'key-count';
      const parsedLimit = safeLimit(limit, 20);
      return await this.metricsService.getClusterSlotStats(parsedOrderBy, parsedLimit, id);
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      if (msg.includes('not supported')) {
        return { error: 'not_supported', message: 'CLUSTER SLOT-STATS requires Valkey 8.0+.' };
      }
      if (msg.includes('CLUSTERDOWN') || msg.includes('cluster mode')) {
        return { error: 'not_cluster', message: 'This instance is not running in cluster mode.' };
      }
      this.logger.error(`Failed to get cluster slot stats for ${id}`, error instanceof Error ? error.stack : error);
      throw new HttpException('Failed to get cluster slot stats', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('instance/:id/latency/history/:eventName')
  async getLatencyHistory(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Param('eventName') eventName: string,
  ) {
    if (!EVENT_NAME_RE.test(eventName)) {
      throw new BadRequestException('Invalid event name');
    }
    try {
      return await this.metricsService.getLatencyHistory(eventName, id);
    } catch (error) {
      this.logger.error(`Failed to get latency history for ${id}/${eventName}`, error instanceof Error ? error.stack : error);
      throw new HttpException('Failed to get latency history', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('instance/:id/audit')
  async getAuditEntries(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('username') username?: string,
    @Query('reason') reason?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      return await this.storageClient.getAclEntries({
        username,
        reason,
        startTime: msToSeconds(startTime),
        endTime: msToSeconds(endTime),
        limit: limit !== undefined ? safeLimit(limit, MAX_LIMIT) : undefined,
        connectionId: id,
      });
    } catch (error) {
      this.logger.error(`Failed to get audit entries for ${id}`, error instanceof Error ? error.stack : error);
      throw new HttpException('Failed to get audit entries', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('instance/:id/hot-keys')
  async getHotKeys(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      const parsedLimit = safeLimit(limit, 50);
      return await this.storageClient.getHotKeys({
        connectionId: id,
        startTime: safeParseInt(startTime),
        endTime: safeParseInt(endTime),
        limit: Math.min(parsedLimit, 200),
        latest: true,
      });
    } catch (error) {
      this.logger.error(`Failed to get hot keys for ${id}`, error instanceof Error ? error.stack : error);
      throw new HttpException('Failed to get hot keys', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('instance/:id/health')
  async getHealth(@Param('id', ValidateInstanceIdPipe) id: string) {
    try {
      return await this.metricsService.getHealthSummary(id);
    } catch (error) {
      this.logger.error(`Failed to get health for ${id}`, error instanceof Error ? error.stack : error);
      throw new HttpException('Failed to get health', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('telemetry')
  async postTelemetry(
    @Body() body: { events?: Array<{ toolName: string; success: boolean; durationMs: number; timestamp?: number; error?: string }> },
  ) {
    if (!this.telemetryService) {
      return { ok: true };
    }
    const events = body?.events;
    if (!Array.isArray(events) || events.length === 0 || events.length > 100) {
      throw new BadRequestException('events must be an array of 1–100 items');
    }
    await Promise.all(events.map(event =>
      this.telemetryService!.trackMcpToolCall({
        toolName: event.toolName,
        success: event.success,
        durationMs: event.durationMs,
        error: event.error,
      }),
    ));
    return { ok: true };
  }
}
