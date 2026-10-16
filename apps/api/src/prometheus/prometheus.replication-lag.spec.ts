import { ConfigService } from '@nestjs/config';
import { PrometheusService } from './prometheus.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { SlowLogAnalyticsService } from '../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../health/health.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';

const CONNECTION_ID = 'conn-1';
const INSTANCE = { host: '10.0.0.1', port: 6379 };

describe('PrometheusService replication lag alert', () => {
  let service: PrometheusService;
  let dispatchReplicationLag: jest.Mock;
  let clearReplicationLag: jest.Mock;

  beforeEach(() => {
    dispatchReplicationLag = jest.fn().mockResolvedValue(undefined);
    clearReplicationLag = jest.fn();
    service = new PrometheusService(
      {} as StoragePort,
      {
        getConfig: jest.fn().mockReturnValue(INSTANCE),
        list: jest.fn().mockReturnValue([]),
      } as unknown as ConnectionRegistry,
      { get: jest.fn((_key: string, fallback?: unknown) => fallback) } as unknown as ConfigService,
      {} as RuntimeCapabilityTracker,
      {} as SlowLogAnalyticsService,
      {} as CommandLogAnalyticsService,
      {} as HealthService,
      undefined,
      { dispatchReplicationLag, clearReplicationLag } as never,
    );
  });

  function poll(replication: Record<string, string>): void {
    service['updateReplicationMetrics']({ replication } as never, 'primary', CONNECTION_ID, INSTANCE, false);
  }

  it('dispatches a lag sample while the master link is up', () => {
    poll({ role: 'slave', master_link_status: 'up', master_last_io_seconds_ago: '30' });
    expect(dispatchReplicationLag).toHaveBeenCalledWith(
      expect.objectContaining({ lagSeconds: 30, connectionId: CONNECTION_ID }),
    );
    expect(clearReplicationLag).not.toHaveBeenCalled();
  });

  it('clears the lag alert when the master link drops', () => {
    poll({ role: 'slave', master_link_status: 'down', master_last_io_seconds_ago: '30' });
    expect(dispatchReplicationLag).not.toHaveBeenCalled();
    expect(clearReplicationLag).toHaveBeenCalledWith(CONNECTION_ID);
  });

  it('clears the lag alert when the replica is promoted', () => {
    poll({ role: 'master', connected_slaves: '0', master_repl_offset: '0' });
    expect(clearReplicationLag).toHaveBeenCalledWith(CONNECTION_ID);
  });
});
