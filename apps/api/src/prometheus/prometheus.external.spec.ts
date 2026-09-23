import { ConfigService } from '@nestjs/config';
import { PrometheusService } from './prometheus.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { SlowLogAnalyticsService } from '../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../health/health.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';

describe('PrometheusService.updateMetrics with external connections', () => {
  it('skips external connections when exporting', async () => {
    const registry = {
      list: jest.fn().mockReturnValue([
        { id: 'direct-1', name: 'polled', isConnected: true, connectionType: 'direct' },
        { id: 'ext-1', name: 'pushed', isConnected: true, connectionType: 'external' },
        { id: 'agent-1', name: 'agent', isConnected: true, connectionType: 'agent' },
      ]),
    } as unknown as ConnectionRegistry;
    const service = new PrometheusService(
      {} as StoragePort,
      registry,
      { get: jest.fn().mockReturnValue(5000) } as unknown as ConfigService,
      {} as RuntimeCapabilityTracker,
      {} as SlowLogAnalyticsService,
      {} as CommandLogAnalyticsService,
      {} as HealthService,
    );
    const info = jest.spyOn(service as any, 'updateMetricsForConnection').mockResolvedValue(undefined);
    const stored = jest.spyOn(service as any, 'updateStorageBasedMetricsForConnection').mockResolvedValue(undefined);

    await service.updateMetrics();

    expect(info.mock.calls.map(([id]) => id)).toEqual(['direct-1', 'agent-1']);
    expect(stored.mock.calls.map(([id]) => id)).toEqual(['direct-1', 'agent-1']);
  });
});
