import type { ConfigService } from '@nestjs/config';
import type { ConnectionRegistry } from '../../connections/connection-registry.service';
import type { StoragePort, StoredAnomalyEvent } from '../../common/interfaces/storage-port.interface';
import { HealthGateService } from '../health-gate.service';

const CONNECTION_ID = 'conn-1';

function makeInfo(overrides: {
  used_memory?: string;
  maxmemory?: string;
  role?: string;
  master_repl_offset?: string;
  slave_repl_offset?: string;
  master_failover_state?: string;
} = {}): unknown {
  return {
    memory: {
      used_memory: overrides.used_memory ?? '1000',
      maxmemory: overrides.maxmemory ?? '10000',
    },
    replication: {
      role: overrides.role ?? 'master',
      master_repl_offset: overrides.master_repl_offset,
      slave_repl_offset: overrides.slave_repl_offset,
      master_failover_state: overrides.master_failover_state,
    },
  };
}

function makeService({
  info,
  anomalyEvents = [],
}: {
  info: unknown;
  anomalyEvents?: StoredAnomalyEvent[];
}) {
  const client = { getInfoParsed: jest.fn().mockResolvedValue(info) };
  const registry = { get: jest.fn().mockReturnValue(client) } as unknown as ConnectionRegistry;
  const storage = {
    getAnomalyEvents: jest.fn().mockImplementation(({ metricType }: { metricType?: string }) => {
      return Promise.resolve(anomalyEvents.filter((e) => e.metricType === metricType));
    }),
  } as unknown as StoragePort;
  const configService = {
    get: jest.fn((_key: string, defaultValue: number) => defaultValue),
  } as unknown as ConfigService;

  return {
    service: new HealthGateService(registry, storage, configService),
    client,
    registry,
    storage,
  };
}

describe('HealthGateService', () => {
  it('allows the capture for a healthy primary with no recent anomalies', async () => {
    const { service } = makeService({ info: makeInfo({ used_memory: '1000', maxmemory: '10000' }) });
    const result = await service.evaluate(CONNECTION_ID);
    expect(result.allow).toBe(true);
    expect(result.signals).toEqual({
      memoryPct: 0.1,
      oomEventsRecent: 0,
      replicationLagBytes: 0,
      failoverInProgress: false,
    });
  });

  it('treats memoryPct as 0 when maxmemory is not set', async () => {
    const { service } = makeService({ info: makeInfo({ used_memory: '999999', maxmemory: '0' }) });
    const result = await service.evaluate(CONNECTION_ID);
    expect(result.signals.memoryPct).toBe(0);
    expect(result.allow).toBe(true);
  });

  it('skips when memoryPct is at or above the threshold', async () => {
    const { service } = makeService({ info: makeInfo({ used_memory: '9000', maxmemory: '10000' }) });
    const result = await service.evaluate(CONNECTION_ID);
    expect(result).toMatchObject({ allow: false, skipReason: 'memory_above_threshold' });
  });

  it('computes replication lag from master/slave offsets on a replica', async () => {
    const { service } = makeService({
      info: makeInfo({
        role: 'replica',
        master_repl_offset: '100000000',
        slave_repl_offset: '50000000',
      }),
    });
    const result = await service.evaluate(CONNECTION_ID);
    expect(result.signals.replicationLagBytes).toBe(50_000_000);
    expect(result).toMatchObject({ allow: false, skipReason: 'replication_lag_elevated' });
  });

  it('does not compute lag on a primary regardless of offsets', async () => {
    const { service } = makeService({
      info: makeInfo({ role: 'master', master_repl_offset: '999999999', slave_repl_offset: '0' }),
    });
    const result = await service.evaluate(CONNECTION_ID);
    expect(result.signals.replicationLagBytes).toBe(0);
    expect(result.allow).toBe(true);
  });

  it('detects failover from INFO master_failover_state', async () => {
    const { service } = makeService({
      info: makeInfo({ master_failover_state: 'waiting-for-sync' }),
    });
    const result = await service.evaluate(CONNECTION_ID);
    expect(result).toMatchObject({ allow: false, skipReason: 'failover_in_progress' });
    expect(result.signals.failoverInProgress).toBe(true);
  });

  it('treats master_failover_state="no-failover" as no failover', async () => {
    const { service } = makeService({
      info: makeInfo({ master_failover_state: 'no-failover' }),
    });
    const result = await service.evaluate(CONNECTION_ID);
    expect(result.signals.failoverInProgress).toBe(false);
    expect(result.allow).toBe(true);
  });

  it('detects failover from a recent role-change anomaly in storage', async () => {
    const { service } = makeService({
      info: makeInfo(),
      anomalyEvents: [
        {
          id: 'a1',
          timestamp: Date.now(),
          metricType: 'replication_role',
          anomalyType: 'drop',
          severity: 'critical',
          value: 0,
          baseline: 1,
          stdDev: 0,
          zScore: 0,
          threshold: 0,
          message: 'role change',
          resolved: false,
          connectionId: CONNECTION_ID,
        },
      ],
    });
    const result = await service.evaluate(CONNECTION_ID);
    expect(result.signals.failoverInProgress).toBe(true);
    expect(result).toMatchObject({ allow: false, skipReason: 'failover_in_progress' });
  });

  it('skips on recent OOM-correlated memory anomalies', async () => {
    const { service } = makeService({
      info: makeInfo(),
      anomalyEvents: [
        {
          id: 'a2',
          timestamp: Date.now(),
          metricType: 'memory_used',
          anomalyType: 'spike',
          severity: 'critical',
          value: 0,
          baseline: 0,
          stdDev: 0,
          zScore: 0,
          threshold: 0,
          message: 'memory spike',
          resolved: false,
          connectionId: CONNECTION_ID,
        },
      ],
    });
    const result = await service.evaluate(CONNECTION_ID);
    expect(result.signals.oomEventsRecent).toBe(1);
    expect(result).toMatchObject({ allow: false, skipReason: 'recent_oom' });
  });

  it('queries storage scoped to the requested connectionId', async () => {
    const { service, storage } = makeService({ info: makeInfo() });
    await service.evaluate(CONNECTION_ID);
    expect(storage.getAnomalyEvents).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: CONNECTION_ID, metricType: 'memory_used' }),
    );
    expect(storage.getAnomalyEvents).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: CONNECTION_ID, metricType: 'replication_role' }),
    );
  });
});
