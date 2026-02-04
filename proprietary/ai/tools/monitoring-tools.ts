import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { MetricsService } from '@app/metrics/metrics.service';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import { ClientAnalyticsService } from '@app/client-analytics/client-analytics.service';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';

export interface ToolDependencies {
  metricsService: MetricsService;
  storageClient: StoragePort;
  clientAnalyticsService: ClientAnalyticsService;
  connectionRegistry: ConnectionRegistry;
}

export function createMonitoringTools(deps: ToolDependencies) {
  const { metricsService, storageClient, clientAnalyticsService, connectionRegistry } = deps;

  // Note: connectionId is injected by chatbot service at runtime for multi-database scoping
  // It's intentionally not exposed in tool schemas to prevent LLM from providing incorrect values

  const getServerStatus = tool(
    async ({ connectionId }: { connectionId?: string }) => {
      const info = await metricsService.getInfoParsed(['server', 'clients', 'memory', 'stats'], connectionId);
      const dbSize = await metricsService.getDbSize(connectionId);
      let connection;
      try {
        connection = connectionRegistry.get(connectionId);
      } catch {
        return JSON.stringify({ error: `Connection not found: ${connectionId ?? 'default'}` });
      }
      const capabilities = connection.getCapabilities();

      return JSON.stringify({
        database: `${capabilities.dbType} ${capabilities.version}`,
        connected_clients: info.clients?.connected_clients ?? 0,
        blocked_clients: info.clients?.blocked_clients ?? 0,
        memory_used: info.memory?.used_memory_human ?? 'unknown',
        memory_peak: info.memory?.used_memory_peak_human ?? 'unknown',
        ops_per_sec: info.stats?.instantaneous_ops_per_sec ?? 0,
        total_keys: dbSize,
        uptime_days: info.server?.uptime_in_days ?? 0,
      });
    },
    {
      name: 'get_server_status',
      description: 'Get current server status: connected clients, memory usage, ops/sec, total keys, uptime',
      schema: z.object({}).passthrough(),
    }
  );

  const getConnectedClients = tool(
    async ({ connectionId }: { connectionId?: string }) => {
      const info = await metricsService.getInfoParsed(['clients'], connectionId);
      return JSON.stringify({
        connected: info.clients?.connected_clients ?? 0,
        blocked: info.clients?.blocked_clients ?? 0,
      });
    },
    {
      name: 'get_connected_clients',
      description: 'Get number of connected and blocked clients',
      schema: z.object({}).passthrough(),
    }
  );

  const getMemoryUsage = tool(
    async ({ connectionId }: { connectionId?: string }) => {
      const info = await metricsService.getInfoParsed(['memory'], connectionId);
      return JSON.stringify({
        used: info.memory?.used_memory_human ?? 'unknown',
        peak: info.memory?.used_memory_peak_human ?? 'unknown',
        fragmentation_ratio: info.memory?.mem_fragmentation_ratio ?? 'unknown',
      });
    },
    {
      name: 'get_memory_usage',
      description: 'Get memory usage statistics',
      schema: z.object({}).passthrough(),
    }
  );

  const getKeyCount = tool(
    async ({ connectionId }: { connectionId?: string }) => {
      const dbSize = await metricsService.getDbSize(connectionId);
      return JSON.stringify({ total_keys: dbSize });
    },
    {
      name: 'get_key_count',
      description: 'Get total number of keys in the database',
      schema: z.object({}).passthrough(),
    }
  );

  const getSlowlog = tool(
    async ({ count, connectionId }: { count: number; connectionId?: string }) => {
      // Parameters: count, excludeClientName, startTime, endTime, connectionId
      const entries = await metricsService.getSlowLog(count, undefined, undefined, undefined, connectionId);
      return JSON.stringify(
        entries.slice(0, count).map((e) => ({
          command: e.command.slice(0, 5).join(' '),
          duration_ms: (e.duration / 1000).toFixed(2),
          timestamp: new Date(e.timestamp * 1000).toISOString(),
          client: e.clientAddress,
        }))
      );
    },
    {
      name: 'get_slowlog',
      description: 'Get slow command log entries',
      schema: z.object({
        count: z.number().default(10).describe('Number of entries to return'),
      }).passthrough(),
    }
  );

  const getSlowlogPatterns = tool(
    async ({ connectionId }: { connectionId?: string }) => {
      const analysis = await metricsService.getSlowLogPatternAnalysis(undefined, connectionId);
      return JSON.stringify({
        total_entries: analysis.totalEntries,
        patterns: analysis.patterns.slice(0, 5).map((p) => ({
          pattern: p.pattern,
          count: p.count,
          percentage: p.percentage.toFixed(1),
          avg_duration_ms: (p.avgDuration / 1000).toFixed(2),
        })),
      });
    },
    {
      name: 'get_slowlog_patterns',
      description: 'Analyze slow command patterns to identify common slow queries',
      schema: z.object({}).passthrough(),
    }
  );

  const getClientList = tool(
    async ({ limit, connectionId }: { limit: number; connectionId?: string }) => {
      const clients = await metricsService.getClients(undefined, connectionId);
      const byName: Record<string, number> = {};
      clients.forEach((c) => {
        const name = c.name || 'unnamed';
        byName[name] = (byName[name] || 0) + 1;
      });

      return JSON.stringify({
        total: clients.length,
        by_name: Object.entries(byName)
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([name, count]) => ({ name, count })),
      });
    },
    {
      name: 'get_client_list',
      description: 'Get list of connected clients grouped by name',
      schema: z.object({
        limit: z.number().default(10).describe('Max number of client groups to return'),
      }).passthrough(),
    }
  );

  const getAclFailures = tool(
    async ({ hours, connectionId }: { hours: number; connectionId?: string }) => {
      const endTime = Date.now();
      const startTime = endTime - hours * 60 * 60 * 1000;

      const entries = await storageClient.getAclEntries({
        startTime,
        endTime,
        limit: 20,
        connectionId,
      });

      return JSON.stringify({
        period_hours: hours,
        count: entries.length,
        entries: entries.slice(0, 10).map((e) => ({
          username: e.username,
          reason: e.reason,
          object: e.object,
          count: e.count,
        })),
      });
    },
    {
      name: 'get_acl_failures',
      description: 'Get ACL/authentication failures from audit log',
      schema: z.object({
        hours: z.number().default(24).describe('Look back period in hours'),
      }).passthrough(),
    }
  );

  const getClientAnalytics = tool(
    async ({ hours, connectionId }: { hours: number; connectionId?: string }) => {
      const endTime = Date.now();
      const startTime = endTime - hours * 60 * 60 * 1000;
      const stats = await clientAnalyticsService.getStats(startTime, endTime, connectionId);

      return JSON.stringify({
        period_hours: hours,
        current_connections: stats.currentConnections,
        peak_connections: stats.peakConnections,
        unique_client_names: stats.uniqueClientNames,
        unique_users: stats.uniqueUsers,
        unique_ips: stats.uniqueIps,
      });
    },
    {
      name: 'get_client_analytics',
      description: 'Get client connection analytics and trends',
      schema: z.object({
        hours: z.number().default(24).describe('Look back period in hours'),
      }).passthrough(),
    }
  );

  const runLatencyDiagnosis = tool(
    async ({ connectionId }: { connectionId?: string }) => {
      const report = await metricsService.getLatencyDoctor(connectionId);
      return report;
    },
    {
      name: 'run_latency_diagnosis',
      description: 'Run latency diagnostic analysis',
      schema: z.object({}).passthrough(),
    }
  );

  const runMemoryDiagnosis = tool(
    async ({ connectionId }: { connectionId?: string }) => {
      const report = await metricsService.getMemoryDoctor(connectionId);
      return report;
    },
    {
      name: 'run_memory_diagnosis',
      description: 'Run memory diagnostic analysis',
      schema: z.object({}).passthrough(),
    }
  );

  return [
    getServerStatus,
    getConnectedClients,
    getMemoryUsage,
    getKeyCount,
    getSlowlog,
    getSlowlogPatterns,
    getClientList,
    getAclFailures,
    getClientAnalytics,
    runLatencyDiagnosis,
    runMemoryDiagnosis,
  ];
}
