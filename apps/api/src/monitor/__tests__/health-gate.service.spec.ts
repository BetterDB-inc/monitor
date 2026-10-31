import type { ConfigService } from '@nestjs/config';
import type { ConnectionRegistry } from '../../connections/connection-registry.service';
import type { StoragePort, StoredAnomalyEvent } from '../../common/interfaces/storage-port.interface';
import { InfoParser } from '../../database/parsers/info.parser';
import { MetricsParser } from '../../database/parsers/metrics.parser';
import { HealthGateService } from '../health-gate.service';

const CONNECTION_ID = 'conn-1';

function makeInfo(overrides: {
  used_memory?: string;
  maxmemory?: string;
  role?: string;
  master_repl_offset?: string;
  slave_repl_offset?: string;
  master_failover_state?: string;
  connected_slaves?: string;
  master_link_status?: string;
  master_sync_in_progress?: string;
  master_last_io_seconds_ago?: string;
  replicas?: Record<string, string>;
} = {}): unknown {
  return {
    memory: {
      used_memory: overrides.used_memory ?? '1000',
      maxmemory: overrides.maxmemory ?? '10000',
    },
    replication: {
      role: overrides.role ?? 'master',
      master_repl_offset:
        'master_repl_offset' in overrides ? overrides.master_repl_offset : '1000',
      slave_repl_offset: overrides.slave_repl_offset,
      connected_slaves: overrides.connected_slaves,
      master_failover_state: overrides.master_failover_state,
      master_link_status: overrides.master_link_status,
      master_sync_in_progress: overrides.master_sync_in_progress,
      master_last_io_seconds_ago: overrides.master_last_io_seconds_ago,
      ...overrides.replicas,
    },
  };
}

function makeService({
  info,
  nextInfo = info,
  anomalyEvents = [],
  config = {},
}: {
  info: unknown;
  nextInfo?: unknown;
  anomalyEvents?: StoredAnomalyEvent[];
  config?: Record<string, number>;
}) {
  const client = {
    getInfoParsed: jest.fn().mockResolvedValueOnce(info).mockResolvedValue(nextInfo),
  };
  const registry = { get: jest.fn().mockReturnValue(client) } as unknown as ConnectionRegistry;
  const storage = {
    getAnomalyEvents: jest.fn().mockImplementation(({ metricType }: { metricType?: string }) => {
      return Promise.resolve(anomalyEvents.filter((e) => e.metricType === metricType));
    }),
  } as unknown as StoragePort;
  const configService = {
    get: jest.fn((key: string, defaultValue: number) => config[key] ?? defaultValue),
  } as unknown as ConfigService;

  return {
    service: new HealthGateService(registry, storage, configService),
    client,
    registry,
    storage,
  };
}

async function evaluateSettled(service: HealthGateService) {
  const pending = service.evaluate(CONNECTION_ID);
  await jest.runAllTimersAsync();
  return pending;
}

describe('HealthGateService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('allows the capture for a healthy primary with no recent anomalies', async () => {
    const { service } = makeService({ info: makeInfo({ used_memory: '1000', maxmemory: '10000' }) });
    const result = await evaluateSettled(service);
    expect(result.allow).toBe(true);
    expect(result.signals).toEqual({
      memoryPct: 0.1,
      oomEventsRecent: 0,
      replicationLagBytes: 0,
      replicaLinkDown: null,
      failoverInProgress: false,
    });
  });

  it('treats memoryPct as 0 when maxmemory is not set', async () => {
    const { service } = makeService({ info: makeInfo({ used_memory: '999999', maxmemory: '0' }) });
    const result = await evaluateSettled(service);
    expect(result.signals.memoryPct).toBe(0);
    expect(result.allow).toBe(true);
  });

  it('skips when memoryPct is at or above the threshold', async () => {
    const { service } = makeService({ info: makeInfo({ used_memory: '9000', maxmemory: '10000' }) });
    const result = await evaluateSettled(service);
    expect(result).toMatchObject({ allow: false, skipReason: 'memory_above_threshold' });
  });

  it.each(['master', 'primary'])(
    'computes replication lag on a %s from the furthest-behind online replica',
    async (role) => {
      const { service } = makeService({
        info: makeInfo({
          role,
          master_repl_offset: '100000000',
          replicas: {
            slave0: 'ip=10.0.0.2,port=6379,state=online,offset=99000000,lag=0',
            slave1: 'ip=10.0.0.3,port=6379,state=online,offset=50000000,lag=4',
          },
        }),
      });
      const result = await evaluateSettled(service);
      expect(result.signals.replicationLagBytes).toBe(50_000_000);
      expect(result).toMatchObject({ allow: false, skipReason: 'replication_lag_elevated' });
    },
  );

  it('counts a replica that is far behind even when it acked within the last second', async () => {
    const { service } = makeService({
      info: makeInfo({
        role: 'master',
        master_repl_offset: '600000000',
        replicas: { slave0: 'ip=10.0.0.2,port=6379,state=online,offset=90000000,lag=0' },
      }),
      nextInfo: makeInfo({
        role: 'master',
        master_repl_offset: '610000000',
        replicas: { slave0: 'ip=10.0.0.2,port=6379,state=online,offset=100000000,lag=0' },
      }),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBe(500_000_000);
    expect(result).toMatchObject({ allow: false, skipReason: 'replication_lag_elevated' });
  });

  it.each(['0', '1', '2'])(
    'does not count in-flight writes on a busy primary when a replica acked %ss ago',
    async (lag) => {
      const { service } = makeService({
        info: makeInfo({
          role: 'master',
          master_repl_offset: '100000000',
          replicas: { slave0: `ip=10.0.0.2,port=6379,state=online,offset=70000000,lag=${lag}` },
        }),
        nextInfo: makeInfo({
          role: 'master',
          master_repl_offset: '130000000',
          replicas: { slave0: `ip=10.0.0.2,port=6379,state=online,offset=100000000,lag=${lag}` },
        }),
      });
      const result = await evaluateSettled(service);
      expect(result.signals.replicationLagBytes).toBe(0);
      expect(result.allow).toBe(true);
    },
  );

  it('reports no negative lag once a replica passes the first primary offset', async () => {
    const { service } = makeService({
      info: makeInfo({
        role: 'master',
        master_repl_offset: '100000000',
        replicas: { slave0: 'ip=10.0.0.2,port=6379,state=online,offset=70000000,lag=0' },
      }),
      nextInfo: makeInfo({
        role: 'master',
        master_repl_offset: '130000000',
        replicas: { slave0: 'ip=10.0.0.2,port=6379,state=online,offset=125000000,lag=0' },
      }),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBe(0);
  });

  it('counts a stalled replica by its gap to the first primary offset', async () => {
    const { service } = makeService({
      info: makeInfo({
        role: 'master',
        master_repl_offset: '100000000',
        replicas: { slave0: 'ip=10.0.0.2,port=6379,state=online,offset=50000000,lag=2' },
      }),
      nextInfo: makeInfo({
        role: 'master',
        master_repl_offset: '130000000',
        replicas: { slave0: 'ip=10.0.0.2,port=6379,state=online,offset=50000000,lag=3' },
      }),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBe(50_000_000);
  });

  it('waits past one replica ack interval before taking the second sample', async () => {
    const info = makeInfo({
      role: 'master',
      replicas: { slave0: 'ip=10.0.0.2,port=6379,state=online,offset=1000,lag=0' },
    });
    const { service, client } = makeService({ info });
    const pending = service.evaluate(CONNECTION_ID);
    await jest.advanceTimersByTimeAsync(1000);
    expect(client.getInfoParsed).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(100);
    expect(client.getInfoParsed).toHaveBeenCalledTimes(2);
    await pending;
  });

  it('takes one sample when no replica can be measured', async () => {
    const { service, client } = makeService({ info: makeInfo({ role: 'master' }) });
    await evaluateSettled(service);
    expect(client.getInfoParsed).toHaveBeenCalledTimes(1);
  });

  it('reads the other signals from the latest sample', async () => {
    const { service } = makeService({
      info: makeInfo({
        role: 'master',
        used_memory: '1000',
        replicas: { slave0: 'ip=10.0.0.2,port=6379,state=online,offset=1000,lag=0' },
      }),
      nextInfo: makeInfo({
        role: 'master',
        used_memory: '9000',
        replicas: { slave0: 'ip=10.0.0.2,port=6379,state=online,offset=1000,lag=0' },
      }),
    });
    const result = await evaluateSettled(service);
    expect(result).toMatchObject({ allow: false, skipReason: 'memory_above_threshold' });
  });

  it('measures a replica line that has no lag field', async () => {
    const { service } = makeService({
      info: makeInfo({
        role: 'master',
        master_repl_offset: '100000000',
        replicas: { slave0: 'ip=10.0.0.2,port=6379,state=online,offset=50000000' },
      }),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBe(50_000_000);
  });

  it.each([
    ['missing', 'ip=10.0.0.2,port=6379,state=online,lag=4'],
    ['unparseable', 'ip=10.0.0.2,port=6379,state=online,offset=abc,lag=4'],
  ])('leaves out a replica whose offset is %s', async (_name, line) => {
    const { service } = makeService({
      info: makeInfo({
        role: 'master',
        master_repl_offset: '100000000',
        replicas: { slave0: line },
      }),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBeNull();
    expect(result.allow).toBe(true);
  });

  it('reads replicaN lines as well as slaveN lines', async () => {
    const { service } = makeService({
      info: makeInfo({
        role: 'primary',
        master_repl_offset: '100000000',
        replicas: { replica0: 'ip=10.0.0.2,port=6379,state=online,offset=50000000,lag=4' },
      }),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBe(50_000_000);
  });

  it('skips replica fields without a key=value shape', async () => {
    const { service } = makeService({
      info: makeInfo({
        role: 'master',
        master_repl_offset: '100000000',
        replicas: { slave0: 'state=online, offset=50000000,garbage,__proto__=x,lag=4' },
      }),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBe(50_000_000);
  });

  it('evaluates replication from raw INFO through the real parsers', async () => {
    const raw = [
      '# Memory',
      'used_memory:1000',
      'maxmemory:10000',
      '# Replication',
      'role:master',
      'connected_slaves:1',
      'slave0:ip=10.0.0.2,port=6379,state=online,offset=50000000,lag=4',
      'master_failover_state:no-failover',
      'master_repl_offset:100000000',
      '',
    ].join('\r\n');
    const { service } = makeService({
      info: MetricsParser.parseInfoToTyped(InfoParser.parse(raw)),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBe(50_000_000);
    expect(result).toMatchObject({ allow: false, skipReason: 'replication_lag_elevated' });
  });

  it('reports lag as unavailable when master_repl_offset is missing', async () => {
    const { service } = makeService({
      info: makeInfo({
        role: 'master',
        master_repl_offset: undefined,
        replicas: { slave0: 'ip=10.0.0.2,port=6379,state=online,offset=50000000,lag=4' },
      }),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBeNull();
    expect(result.allow).toBe(true);
  });

  it('reports lag as unavailable when INFO has no replication section', async () => {
    const { service } = makeService({
      info: { memory: { used_memory: '1000', maxmemory: '10000' } },
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBeNull();
    expect(result.signals.replicaLinkDown).toBeNull();
  });

  it('ignores replicas still in their initial sync', async () => {
    const { service } = makeService({
      info: makeInfo({
        role: 'master',
        master_repl_offset: '100000000',
        replicas: {
          slave0: 'ip=10.0.0.2,port=6379,state=online,offset=100000000,lag=0',
          slave1: 'ip=10.0.0.3,port=6379,state=wait_bgsave,offset=0,lag=0',
        },
      }),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBe(0);
    expect(result.allow).toBe(true);
  });

  it.each([
    ['a SYNC consumer that never acks', '12'],
    ['a new replica loading its RDB', '0'],
  ])('leaves out %s reporting offset 0', async (_name, lag) => {
    const { service } = makeService({
      info: makeInfo({
        role: 'master',
        master_repl_offset: '100000000',
        replicas: {
          slave0: 'ip=10.0.0.2,port=6379,state=online,offset=100000000,lag=0',
          slave1: `ip=10.0.0.3,port=6379,state=online,offset=0,lag=${lag}`,
        },
      }),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBe(0);
    expect(result.allow).toBe(true);
  });

  it.each([
    ['a replica still in its initial sync', 'ip=10.0.0.3,port=6379,state=wait_bgsave,offset=0,lag=0'],
    ['a replica without an acked offset', 'ip=10.0.0.3,port=6379,state=online,offset=0,lag=12'],
  ])('reports lag as unavailable when the only replica is %s', async (_name, line) => {
    const { service } = makeService({
      info: makeInfo({
        role: 'master',
        master_repl_offset: '100000000',
        connected_slaves: '1',
        replicas: { slave0: line },
      }),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBeNull();
    expect(result.allow).toBe(true);
  });

  it('reports lag as unavailable when connected replicas have no slaveN lines', async () => {
    const { service } = makeService({
      info: makeInfo({ role: 'master', master_repl_offset: '100000000', connected_slaves: '2' }),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBeNull();
    expect(result.allow).toBe(true);
  });

  it('reports no lag on a primary without replicas', async () => {
    const { service } = makeService({
      info: makeInfo({ role: 'master', master_repl_offset: '999999999', connected_slaves: '0' }),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBe(0);
    expect(result.allow).toBe(true);
  });

  it("does not read lag from a replica's own offsets", async () => {
    const { service } = makeService({
      info: makeInfo({
        role: 'slave',
        master_repl_offset: '100000000',
        slave_repl_offset: '50000000',
        master_link_status: 'up',
        master_sync_in_progress: '0',
        master_last_io_seconds_ago: '1',
      }),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBeNull();
    expect(result.signals.replicaLinkDown).toBe(false);
    expect(result.allow).toBe(true);
  });

  it.each(['slave', 'replica', 'active-replica'])(
    'measures the sub-replicas of a chained %s',
    async (role) => {
      const { service } = makeService({
        info: makeInfo({
          role,
          master_repl_offset: '100000000',
          master_link_status: 'up',
          replicas: {
            slave0: 'ip=10.0.0.4,port=6379,state=online,offset=50000000,lag=4',
          },
        }),
      });
      const result = await evaluateSettled(service);
      expect(result.signals.replicationLagBytes).toBe(50_000_000);
      expect(result).toMatchObject({ allow: false, skipReason: 'replication_lag_elevated' });
    },
  );

  it.each([
    ['slave', { master_link_status: 'down' }],
    ['replica', { master_link_status: 'down' }],
    ['active-replica', { master_link_status: 'down' }],
    ['slave', { master_link_status: 'up', master_sync_in_progress: '1' }],
    ['slave', { master_link_status: 'up', master_last_io_seconds_ago: '31' }],
  ])('skips a %s whose link is unhealthy: %j', async (role, link) => {
    const { service } = makeService({ info: makeInfo({ role, ...link }) });
    const result = await evaluateSettled(service);
    expect(result.signals.replicaLinkDown).toBe(true);
    expect(result).toMatchObject({ allow: false, skipReason: 'replica_link_unhealthy' });
  });

  it('allows a replica on an idle link between primary pings', async () => {
    const { service } = makeService({
      info: makeInfo({
        role: 'slave',
        master_link_status: 'up',
        master_sync_in_progress: '0',
        master_last_io_seconds_ago: '30',
      }),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicaLinkDown).toBe(false);
    expect(result.allow).toBe(true);
  });

  it('uses the configured stale I/O limit', async () => {
    const { service } = makeService({
      info: makeInfo({
        role: 'slave',
        master_link_status: 'up',
        master_sync_in_progress: '0',
        master_last_io_seconds_ago: '45',
      }),
      config: { MONITOR_REPLICA_IO_STALE_SEC: 60 },
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicaLinkDown).toBe(false);
    expect(result.allow).toBe(true);
  });

  it.each([
    ['master_link_status', { master_sync_in_progress: '0', master_last_io_seconds_ago: '1' }],
    ['master_sync_in_progress', { master_link_status: 'up', master_last_io_seconds_ago: '1' }],
    ['master_last_io_seconds_ago', { master_link_status: 'up', master_sync_in_progress: '0' }],
  ])('reports the link as unknown when %s is missing', async (_field, link) => {
    const { service } = makeService({ info: makeInfo({ role: 'slave', ...link }) });
    const result = await evaluateSettled(service);
    expect(result.signals.replicaLinkDown).toBeNull();
    expect(result.allow).toBe(true);
  });

  it('reports the link as unknown when master_last_io_seconds_ago is unreadable', async () => {
    const { service } = makeService({
      info: makeInfo({
        role: 'slave',
        master_link_status: 'up',
        master_sync_in_progress: '0',
        master_last_io_seconds_ago: 'soon',
      }),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicaLinkDown).toBeNull();
  });

  describe('KeyDB multi-master links', () => {
    const FIRST_MASTER = {
      master_link_status: 'up',
      master_sync_in_progress: '0',
      master_last_io_seconds_ago: '1',
    };

    it.each([
      [{ master_1_link_status: 'down' }],
      [{ master_1_link_status: 'up', master_1_sync_in_progress: '1' }],
      [
        {
          master_1_link_status: 'up',
          master_1_sync_in_progress: '0',
          master_1_last_io_seconds_ago: '31',
        },
      ],
    ])('skips when a later master is unhealthy: %j', async (secondMaster) => {
      const { service } = makeService({
        info: makeInfo({ role: 'active-replica', ...FIRST_MASTER, replicas: secondMaster }),
      });
      const result = await evaluateSettled(service);
      expect(result.signals.replicaLinkDown).toBe(true);
      expect(result).toMatchObject({ allow: false, skipReason: 'replica_link_unhealthy' });
    });

    it('reports the link as healthy when every master is healthy', async () => {
      const { service } = makeService({
        info: makeInfo({
          role: 'active-replica',
          ...FIRST_MASTER,
          replicas: {
            master_1_link_status: 'up',
            master_1_sync_in_progress: '0',
            master_1_last_io_seconds_ago: '2',
          },
        }),
      });
      const result = await evaluateSettled(service);
      expect(result.signals.replicaLinkDown).toBe(false);
    });

    it('reports the link as unknown when a later master has missing fields', async () => {
      const { service } = makeService({
        info: makeInfo({
          role: 'active-replica',
          ...FIRST_MASTER,
          replicas: { master_1_link_status: 'up' },
        }),
      });
      const result = await evaluateSettled(service);
      expect(result.signals.replicaLinkDown).toBeNull();
    });
  });

  it('does not assess a master link on a primary', async () => {
    const { service } = makeService({
      info: makeInfo({ role: 'master', master_link_status: 'down' }),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicaLinkDown).toBeNull();
    expect(result.allow).toBe(true);
  });

  it('detects failover from INFO master_failover_state', async () => {
    const { service } = makeService({
      info: makeInfo({ master_failover_state: 'waiting-for-sync' }),
    });
    const result = await evaluateSettled(service);
    expect(result).toMatchObject({ allow: false, skipReason: 'failover_in_progress' });
    expect(result.signals.failoverInProgress).toBe(true);
  });

  it('treats master_failover_state="no-failover" as no failover', async () => {
    const { service } = makeService({
      info: makeInfo({ master_failover_state: 'no-failover' }),
    });
    const result = await evaluateSettled(service);
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
    const result = await evaluateSettled(service);
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
    const result = await evaluateSettled(service);
    expect(result.signals.oomEventsRecent).toBe(1);
    expect(result).toMatchObject({ allow: false, skipReason: 'recent_oom' });
  });

  it('queries storage scoped to the requested connectionId', async () => {
    const { service, storage } = makeService({ info: makeInfo() });
    await evaluateSettled(service);
    expect(storage.getAnomalyEvents).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: CONNECTION_ID, metricType: 'memory_used' }),
    );
    expect(storage.getAnomalyEvents).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: CONNECTION_ID, metricType: 'replication_role' }),
    );
  });
});
