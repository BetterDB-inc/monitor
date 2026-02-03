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

  const getServerStatus = tool(
    async () => {
      const info = await metricsService.getInfoParsed(['server', 'clients', 'memory', 'stats']);
      const dbSize = await metricsService.getDbSize();
      const capabilities = connectionRegistry.get().getCapabilities();

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
      schema: z.object({}),
    }
  );

  const getConnectedClients = tool(
    async () => {
      const info = await metricsService.getInfoParsed(['clients']);
      return JSON.stringify({
        connected: info.clients?.connected_clients ?? 0,
        blocked: info.clients?.blocked_clients ?? 0,
      });
    },
    {
      name: 'get_connected_clients',
      description: 'Get number of connected and blocked clients',
      schema: z.object({}),
    }
  );

  const getMemoryUsage = tool(
    async () => {
      const info = await metricsService.getInfoParsed(['memory']);
      return JSON.stringify({
        used: info.memory?.used_memory_human ?? 'unknown',
        peak: info.memory?.used_memory_peak_human ?? 'unknown',
        fragmentation_ratio: info.memory?.mem_fragmentation_ratio ?? 'unknown',
      });
    },
    {
      name: 'get_memory_usage',
      description: 'Get memory usage statistics',
      schema: z.object({}),
    }
  );

  const getKeyCount = tool(
    async () => {
      const dbSize = await metricsService.getDbSize();
      return JSON.stringify({ total_keys: dbSize });
    },
    {
      name: 'get_key_count',
      description: 'Get total number of keys in the database',
      schema: z.object({}),
    }
  );

  const getSlowlog = tool(
    async ({ count }) => {
      const entries = await metricsService.getSlowLog(count);
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
      }),
    }
  );

  const getSlowlogPatterns = tool(
    async () => {
      const analysis = await metricsService.getSlowLogPatternAnalysis();
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
      schema: z.object({}),
    }
  );

  const getClientList = tool(
    async ({ limit }) => {
      const clients = await metricsService.getClients();
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
      }),
    }
  );

  const getAclFailures = tool(
    async ({ hours }) => {
      const endTime = Date.now();
      const startTime = endTime - hours * 60 * 60 * 1000;

      const entries = await storageClient.getAclEntries({
        startTime,
        endTime,
        limit: 20,
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
      }),
    }
  );

  const getClientAnalytics = tool(
    async ({ hours }) => {
      const endTime = Date.now();
      const startTime = endTime - hours * 60 * 60 * 1000;
      const stats = await clientAnalyticsService.getStats(startTime, endTime);

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
      }),
    }
  );

  const runLatencyDiagnosis = tool(
    async () => {
      const report = await metricsService.getLatencyDoctor();
      return report;
    },
    {
      name: 'run_latency_diagnosis',
      description: 'Run latency diagnostic analysis',
      schema: z.object({}),
    }
  );

  const runMemoryDiagnosis = tool(
    async () => {
      const report = await metricsService.getMemoryDoctor();
      return report;
    },
    {
      name: 'run_memory_diagnosis',
      description: 'Run memory diagnostic analysis',
      schema: z.object({}),
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
