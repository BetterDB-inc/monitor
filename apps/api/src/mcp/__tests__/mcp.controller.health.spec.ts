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
  let configHazards: { probeHazards: jest.Mock };

  beforeEach(() => {
    metricsService = { getHealthSummary: jest.fn().mockResolvedValue(summary) };
    configHazards = {
      probeHazards: jest.fn().mockResolvedValue({ findings: [hazardFinding], complete: true }),
    };
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
      withHazardService ? (configHazards as unknown as ConfigHazardService) : undefined,
    );
  };

  it('includes configHazards alongside the health summary', async () => {
    const controller = build(true);
    const result = await controller.getHealth('conn-1');
    expect(result).toMatchObject(summary);
    expect(result.configHazards).toEqual([hazardFinding]);
    expect(result.configHazardsUnavailable).toBeUndefined();
    expect(configHazards.probeHazards).toHaveBeenCalledWith('conn-1');
  });

  it('returns an empty configHazards for a complete clean probe', async () => {
    configHazards.probeHazards.mockResolvedValue({ findings: [], complete: true });
    const controller = build(true);
    const result = await controller.getHealth('conn-1');
    expect(result.configHazards).toEqual([]);
    expect(result).not.toHaveProperty('configHazardsUnavailable');
  });

  it('returns the plain summary when the hazard service is not wired', async () => {
    const controller = build(false);
    const result = await controller.getHealth('conn-1');
    expect(result).toMatchObject(summary);
    expect(result.configHazards).toBeUndefined();
  });

  it('still returns the summary when the hazard probe throws', async () => {
    configHazards.probeHazards.mockRejectedValue(new Error('probe failed'));
    const controller = build(true);
    const result = await controller.getHealth('conn-1');
    expect(result).toMatchObject(summary);
    expect(result.configHazards).toBeUndefined();
    expect(result.configHazardsUnavailable).toBe(true);
  });

  it('does not present an incomplete empty probe as a clean result', async () => {
    configHazards.probeHazards.mockResolvedValue({ findings: [], complete: false });
    const controller = build(true);
    const result = await controller.getHealth('conn-1');
    expect(result.configHazards).toBeUndefined();
    expect(result.configHazardsUnavailable).toBe(true);
  });

  it('keeps partial findings and marks the probe incomplete', async () => {
    configHazards.probeHazards.mockResolvedValue({ findings: [hazardFinding], complete: false });
    const controller = build(true);
    const result = await controller.getHealth('conn-1');
    expect(result.configHazards).toEqual([hazardFinding]);
    expect(result.configHazardsUnavailable).toBe(true);
  });
});
