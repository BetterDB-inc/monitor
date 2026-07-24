import { McpController } from '../mcp.controller';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { MetricsService } from '../../metrics/metrics.service';
import { CommandLogAnalyticsService } from '../../commandlog-analytics/commandlog-analytics.service';
import { ClientAnalyticsAnalysisService } from '../../client-analytics/client-analytics-analysis.service';
import { ClusterDiscoveryService } from '../../cluster/cluster-discovery.service';
import { ClusterMetricsService } from '../../cluster/cluster-metrics.service';
import { StoragePort } from '../../common/interfaces/storage-port.interface';
import { ConfigHazardService } from '../../monitor/config-hazard.service';

describe('McpController getHealth', () => {
  const summary = {
    hitRate: 0.9,
    memFragmentationRatio: 1.1,
    connectedClients: 3,
    replicationLag: null,
    keyspaceSize: 100,
    role: 'master',
  };
  const hazardFinding = {
    id: 'default-user-aof-data-loss' as const,
    severity: 'warning' as const,
    status: 'hazard' as const,
    message: 'valkey#3983',
  };

  let metricsService: { getHealthSummary: jest.Mock };
  let configHazards: { getHazards: jest.Mock };

  beforeEach(() => {
    metricsService = { getHealthSummary: jest.fn().mockResolvedValue(summary) };
    configHazards = { getHazards: jest.fn().mockResolvedValue([hazardFinding]) };
  });

  const build = (withHazardService: boolean): McpController => {
    return new McpController(
      {} as ConnectionRegistry,
      metricsService as unknown as MetricsService,
      {} as CommandLogAnalyticsService,
      {} as ClientAnalyticsAnalysisService,
      {} as ClusterDiscoveryService,
      {} as ClusterMetricsService,
      {} as StoragePort,
      undefined,
      undefined,
      withHazardService ? (configHazards as unknown as ConfigHazardService) : undefined,
    );
  };

  it('includes configHazards alongside the health summary', async () => {
    const controller = build(true);
    const result = await controller.getHealth('conn-1');
    expect(result).toMatchObject(summary);
    expect(result.configHazards).toEqual([hazardFinding]);
    expect(configHazards.getHazards).toHaveBeenCalledWith('conn-1');
  });

  it('returns the plain summary when the hazard service is not wired', async () => {
    const controller = build(false);
    const result = await controller.getHealth('conn-1');
    expect(result).toMatchObject(summary);
    expect(result.configHazards).toBeUndefined();
  });

  it('still returns the summary when the hazard probe throws', async () => {
    configHazards.getHazards.mockRejectedValue(new Error('probe failed'));
    const controller = build(true);
    const result = await controller.getHealth('conn-1');
    expect(result).toMatchObject(summary);
    expect(result.configHazards).toEqual([]);
  });
});
