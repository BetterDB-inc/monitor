import { Controller, Get, Param, Query, HttpException, HttpStatus, UseGuards, Optional, Inject } from '@nestjs/common';
import { ANOMALY_SERVICE } from '@betterdb/shared';
import { RequiresFeature, Feature } from '@proprietary/license';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { AgentTokenGuard } from '../common/guards/agent-token.guard';
import { InfoResponse } from '../common/types/metrics.types';
import { MetricsService } from '../metrics/metrics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { ClientAnalyticsAnalysisService } from '../client-analytics/client-analytics-analysis.service';
import { ClusterDiscoveryService } from '../cluster/cluster-discovery.service';
import { ClusterMetricsService } from '../cluster/cluster-metrics.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';

@Controller('mcp')
@UseGuards(AgentTokenGuard)
export class McpController {
  private readonly anomalyService: any;

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly metricsService: MetricsService,
    private readonly commandLogAnalyticsService: CommandLogAnalyticsService,
    private readonly clientAnalyticsAnalysisService: ClientAnalyticsAnalysisService,
    private readonly clusterDiscoveryService: ClusterDiscoveryService,
    private readonly clusterMetricsService: ClusterMetricsService,
    @Inject('STORAGE_CLIENT') private readonly storageClient: StoragePort,
    @Optional() @Inject(ANOMALY_SERVICE) anomalyService?: any,
  ) {
    this.anomalyService = anomalyService ?? null;
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
  async getInfo(@Param('id') id: string) {
    try {
      const client = this.registry.get(id);
      const info = await client.getInfoParsed();
      return info;
    } catch (error) {
      throw new HttpException(
        `Failed to get info: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instance/:id/slowlog')
  async getSlowlog(@Param('id') id: string, @Query('count') count?: string) {
    try {
      const client = this.registry.get(id);
      const parsedCount = count ? parseInt(count, 10) : 25;
      return await client.getSlowLog(parsedCount);
    } catch (error) {
      throw new HttpException(
        `Failed to get slowlog: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instance/:id/latency')
  async getLatency(@Param('id') id: string) {
    try {
      const client = this.registry.get(id);
      return await client.getLatestLatencyEvents();
    } catch (error) {
      throw new HttpException(
        `Failed to get latency: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instance/:id/memory')
  async getMemory(@Param('id') id: string) {
    try {
      const client = this.registry.get(id);
      const [doctor, stats] = await Promise.all([
        client.getMemoryDoctor(),
        client.getMemoryStats(),
      ]);
      return { doctor, stats };
    } catch (error) {
      throw new HttpException(
        `Failed to get memory diagnostics: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instance/:id/commandlog')
  async getCommandlog(@Param('id') id: string, @Query('count') count?: string) {
    try {
      const client = this.registry.get(id);
      const capabilities = client.getCapabilities();
      if (!capabilities.hasCommandLog) {
        return { entries: [], note: 'COMMANDLOG not supported on this database version' };
      }
      const parsedCount = count ? parseInt(count, 10) : 25;
      return await client.getCommandLog(parsedCount);
    } catch (error) {
      return { entries: [], note: `COMMANDLOG unavailable: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }

  @Get('instance/:id/clients')
  async getClients(@Param('id') id: string) {
    try {
      const client = this.registry.get(id);
      return await client.getClients();
    } catch (error) {
      throw new HttpException(
        `Failed to get clients: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instance/:id/history/slowlog-patterns')
  async getSlowlogPatterns(
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    try {
      const parsedLimit = limit ? parseInt(limit, 10) : undefined;
      return await this.metricsService.getSlowLogPatternAnalysis(parsedLimit, id);
    } catch (error) {
      throw new HttpException(
        `Failed to get slowlog patterns: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instance/:id/history/commandlog')
  async getCommandlogHistory(
    @Param('id') id: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('command') command?: string,
    @Query('minDuration') minDuration?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      return await this.commandLogAnalyticsService.getStoredCommandLog({
        startTime: startTime ? parseInt(startTime, 10) : undefined,
        endTime: endTime ? parseInt(endTime, 10) : undefined,
        command,
        minDuration: minDuration ? parseInt(minDuration, 10) : undefined,
        limit: limit ? parseInt(limit, 10) : 100,
        offset: 0,
        connectionId: id,
      });
    } catch {
      return { entries: [], note: 'COMMANDLOG not available on this instance' };
    }
  }

  @Get('instance/:id/history/commandlog-patterns')
  async getCommandlogPatterns(
    @Param('id') id: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      return await this.commandLogAnalyticsService.getStoredCommandLogPatternAnalysis({
        startTime: startTime ? parseInt(startTime, 10) : undefined,
        endTime: endTime ? parseInt(endTime, 10) : undefined,
        limit: limit ? parseInt(limit, 10) : 500,
        connectionId: id,
      });
    } catch {
      return { entries: [], note: 'COMMANDLOG not available on this instance' };
    }
  }

  @Get('instance/:id/history/anomalies')
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  async getAnomalies(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('metricType') metricType?: string,
    @Query('startTime') startTime?: string,
  ) {
    if (!this.anomalyService || !this.anomalyService.getRecentAnomalies) {
      return { events: [], note: 'Anomaly detection is not available (requires BetterDB Pro)' };
    }
    try {
      const parsedLimit = limit ? parseInt(limit, 10) : 100;
      const parsedStartTime = startTime ? parseInt(startTime, 10) : (Date.now() - 24 * 60 * 60 * 1000);
      return await this.anomalyService.getRecentAnomalies(
        parsedStartTime,
        undefined,
        undefined,
        metricType || undefined,
        parsedLimit,
        id,
      );
    } catch (error) {
      throw new HttpException(
        `Failed to get anomalies: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instance/:id/history/client-activity')
  async getClientActivity(
    @Param('id') id: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('bucketSizeMinutes') bucketSizeMinutes?: string,
  ) {
    try {
      return await this.clientAnalyticsAnalysisService.getActivityTimeline(
        {
          startTime: startTime ? parseInt(startTime, 10) : undefined,
          endTime: endTime ? parseInt(endTime, 10) : undefined,
          bucketSizeMinutes: bucketSizeMinutes ? parseInt(bucketSizeMinutes, 10) : undefined,
        },
        id,
      );
    } catch (error) {
      throw new HttpException(
        `Failed to get client activity: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instance/:id/cluster/nodes')
  async getClusterNodes(@Param('id') id: string) {
    try {
      return await this.clusterDiscoveryService.discoverNodes(id);
    } catch {
      return { error: 'not_cluster', message: 'This instance is not running in cluster mode.' };
    }
  }

  @Get('instance/:id/cluster/node-stats')
  async getClusterNodeStats(@Param('id') id: string) {
    try {
      return await this.clusterMetricsService.getClusterNodeStats();
    } catch {
      return { error: 'not_cluster', message: 'This instance is not running in cluster mode.' };
    }
  }

  @Get('instance/:id/cluster/slowlog')
  async getClusterSlowlog(
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    try {
      const parsedLimit = limit ? parseInt(limit, 10) : 100;
      return await this.clusterMetricsService.getClusterSlowlog(parsedLimit);
    } catch {
      return { error: 'not_cluster', message: 'This instance is not running in cluster mode.' };
    }
  }

  @Get('instance/:id/cluster/slot-stats')
  async getClusterSlotStats(
    @Param('id') id: string,
    @Query('orderBy') orderBy?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      const parsedOrderBy = (orderBy as 'key-count' | 'cpu-usec') || 'key-count';
      const parsedLimit = limit ? parseInt(limit, 10) : 20;
      return await this.metricsService.getClusterSlotStats(parsedOrderBy, parsedLimit, id);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      if (msg.includes('not supported')) {
        return { error: 'not_supported', message: 'CLUSTER SLOT-STATS requires Valkey 8.0+.' };
      }
      return { error: 'not_cluster', message: 'This instance is not running in cluster mode.' };
    }
  }

  @Get('instance/:id/latency/history/:eventName')
  async getLatencyHistory(
    @Param('id') id: string,
    @Param('eventName') eventName: string,
  ) {
    try {
      return await this.metricsService.getLatencyHistory(eventName, id);
    } catch (error) {
      throw new HttpException(
        `Failed to get latency history: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instance/:id/audit')
  async getAuditEntries(
    @Param('id') id: string,
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
        startTime: startTime ? parseInt(startTime, 10) : undefined,
        endTime: endTime ? parseInt(endTime, 10) : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
        connectionId: id,
      });
    } catch (error) {
      throw new HttpException(
        `Failed to get audit entries: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instance/:id/health')
  async getHealth(@Param('id') id: string) {
    try {
      const client = this.registry.get(id);
      const info: InfoResponse = await client.getInfoParsed();

      const stats = info.stats as Record<string, unknown> | undefined;
      const memory = info.memory as Record<string, unknown> | undefined;
      const clients = info.clients as Record<string, unknown> | undefined;
      const replication = info.replication as Record<string, unknown> | undefined;
      const keyspace = info.keyspace as Record<string, unknown> | undefined;

      const keyspaceHits = Number(stats?.keyspace_hits ?? 0);
      const keyspaceMisses = Number(stats?.keyspace_misses ?? 0);
      const totalLookups = keyspaceHits + keyspaceMisses;
      const hitRate = totalLookups > 0 ? keyspaceHits / totalLookups : null;

      const fragRatio = Number(memory?.mem_fragmentation_ratio ?? 0);
      const connectedClients = Number(clients?.connected_clients ?? 0);

      const role = String(replication?.role ?? 'unknown');
      let replicationLag: number | null = null;
      if (role === 'slave' || role === 'replica') {
        const offset = Number(replication?.master_repl_offset ?? 0);
        const slaveOffset = Number(replication?.slave_repl_offset ?? 0);
        replicationLag = offset - slaveOffset;
      }

      let keyspaceSize = 0;
      if (keyspace && typeof keyspace === 'object') {
        for (const [key, val] of Object.entries(keyspace)) {
          if (key.startsWith('db') && typeof val === 'string') {
            const match = val.match(/keys=(\d+)/);
            if (match) keyspaceSize += parseInt(match[1], 10);
          }
        }
      }

      return {
        hitRate,
        memFragmentationRatio: fragRatio,
        connectedClients,
        replicationLag,
        keyspaceSize,
        role,
      };
    } catch (error) {
      throw new HttpException(
        `Failed to get health: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
