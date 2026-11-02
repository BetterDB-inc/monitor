import { Logger } from '@nestjs/common';
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

function primaryInfo(primaryOffset: number, ...replicaOffsets: number[]): unknown {
  return makeInfo({
    role: 'master',
    master_repl_offset: String(primaryOffset),
    replicas: Object.fromEntries(
      replicaOffsets.map((offset, index) => [
        `slave${index}`,
        `ip=10.0.0.${index + 2},port=6379,state=online,offset=${offset},lag=0`,
      ]),
    ),
  });
}

function makeService({
  info,
  samples = [],
  nextInfo = info,
  anomalyEvents = [],
  config = {},
}: {
  info: unknown;
  samples?: unknown[];
  nextInfo?: unknown;
  anomalyEvents?: StoredAnomalyEvent[];
  config?: Record<string, number>;
}) {
  const getInfoParsed = jest.fn().mockResolvedValueOnce(info);
  for (const sample of samples) {
    if (sample instanceof Error) {
      getInfoParsed.mockRejectedValueOnce(sample);
    } else {
      getInfoParsed.mockResolvedValueOnce(sample);
    }
  }
  getInfoParsed.mockResolvedValue(nextInfo);
  const client = { getInfoParsed };
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
    jest.restoreAllMocks();
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
    const info = makeInfo({
      role: 'master',
      master_repl_offset: '600000000',
      replicas: { slave0: 'ip=10.0.0.2,port=6379,state=online,offset=90000000,lag=0' },
    });
    const { service } = makeService({
      info,
      samples: [info],
      nextInfo: makeInfo({
        role: 'master',
        master_repl_offset: '610000000',
        replicas: { slave0: 'ip=10.0.0.2,port=6379,state=online,offset=100000000,lag=0' },
      }),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBe(510_000_000);
    expect(result).toMatchObject({ allow: false, skipReason: 'replication_lag_elevated' });
  });

  it.each(['0', '1', '2'])(
    'counts the writes read with an ack on a busy primary when a replica acked %ss ago',
    async (lag) => {
      const info = makeInfo({
        role: 'master',
        master_repl_offset: '100000000',
        replicas: { slave0: `ip=10.0.0.2,port=6379,state=online,offset=70000000,lag=${lag}` },
      });
      const { service } = makeService({
        info,
        samples: [info],
        nextInfo: makeInfo({
          role: 'master',
          master_repl_offset: '130000000',
          replicas: { slave0: `ip=10.0.0.2,port=6379,state=online,offset=100000000,lag=${lag}` },
        }),
      });
      const result = await evaluateSettled(service);
      expect(result.signals.replicationLagBytes).toBe(30_000_000);
      expect(result).toMatchObject({ allow: false, skipReason: 'replication_lag_elevated' });
    },
  );

  it('measures a replica past the first primary offset against the later one', async () => {
    const info = makeInfo({
      role: 'master',
      master_repl_offset: '100000000',
      replicas: { slave0: 'ip=10.0.0.2,port=6379,state=online,offset=70000000,lag=0' },
    });
    const { service } = makeService({
      info,
      samples: [info],
      nextInfo: makeInfo({
        role: 'master',
        master_repl_offset: '130000000',
        replicas: { slave0: 'ip=10.0.0.2,port=6379,state=online,offset=125000000,lag=0' },
      }),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBe(5_000_000);
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

  it('settles a moved ack still over the limit at the next ack', async () => {
    const { service } = makeService({
      info: primaryInfo(100_000_000, 50_000_000),
      samples: [primaryInfo(150_000_000, 130_000_000), primaryInfo(160_000_000, 131_000_000)],
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBe(29_000_000);
    expect(result).toMatchObject({ allow: false, skipReason: 'replication_lag_elevated' });
  });

  it('stops once the sample before the polls puts a replica under the limit', async () => {
    const { service, client } = makeService({
      info: primaryInfo(100_000_000, 50_000_000),
      samples: [primaryInfo(150_000_000, 149_000_000)],
    });
    const result = await evaluateSettled(service);
    expect(client.getInfoParsed).toHaveBeenCalledTimes(2);
    expect(result.signals.replicationLagBytes).toBe(1_000_000);
    expect(result.allow).toBe(true);
  });

  it('keeps sampling until a late ack lands', async () => {
    const stale = Array.from({ length: 7 }, (_, i) =>
      primaryInfo(100_000_000 + (i + 1) * 6_000_000, 70_000_000),
    );
    const { service, client } = makeService({
      info: primaryInfo(100_000_000, 70_000_000),
      samples: stale,
      nextInfo: primaryInfo(145_000_000, 143_000_000),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBe(2_000_000);
    expect(result.allow).toBe(true);
    expect(client.getInfoParsed).toHaveBeenCalledTimes(9);
  });

  it('measures a steady backlog smaller than the wait for the next ack', async () => {
    const stale = Array.from({ length: 9 }, (_, i) =>
      primaryInfo(100_000_000 + (i + 1) * 5_000_000, 50_000_000),
    );
    const { service } = makeService({
      info: primaryInfo(100_000_000, 50_000_000),
      samples: stale,
      nextInfo: primaryInfo(150_000_000, 100_000_000),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBe(50_000_000);
    expect(result).toMatchObject({ allow: false, skipReason: 'replication_lag_elevated' });
  });

  it('keeps the baseline gap when no ack lands before the timeout', async () => {
    const { service, client } = makeService({
      info: primaryInfo(100_000_000, 50_000_000),
      nextInfo: primaryInfo(130_000_000, 50_000_000),
    });
    const pending = service.evaluate(CONNECTION_ID);
    await jest.advanceTimersByTimeAsync(2500);
    const calls = client.getInfoParsed.mock.calls.length;
    await jest.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(client.getInfoParsed).toHaveBeenCalledTimes(calls);
    expect(result.signals.replicationLagBytes).toBe(50_000_000);
    expect(result).toMatchObject({ allow: false, skipReason: 'replication_lag_elevated' });
  });

  it.each([
    ['the sample before the polls', 0],
    ['a later poll', 1],
  ])('stops at the time budget when %s hangs', async (_name, answeredCalls) => {
    const { service, client } = makeService({
      info: primaryInfo(100_000_000, 50_000_000),
      samples: Array.from({ length: answeredCalls }, () => primaryInfo(100_000_000, 50_000_000)),
    });
    client.getInfoParsed.mockImplementation(() => new Promise(() => undefined));
    const settled = jest.fn();
    const pending = service.evaluate(CONNECTION_ID).then((result) => {
      settled();
      return result;
    });
    await jest.advanceTimersByTimeAsync(2500);
    expect(settled).toHaveBeenCalled();
    const result = await pending;
    expect(result.signals.replicationLagBytes).toBe(50_000_000);
    expect(result).toMatchObject({ allow: false, skipReason: 'replication_lag_elevated' });
  });

  it.each([
    ['its line is gone', makeInfo({ role: 'master', master_repl_offset: '130000000' })],
    [
      'it has fallen back to a resync',
      makeInfo({
        role: 'master',
        master_repl_offset: '130000000',
        replicas: { slave0: 'ip=10.0.0.2,port=6379,state=wait_bgsave,offset=0,lag=0' },
      }),
    ],
  ])('keeps the baseline gap of a replica when %s', async (_name, sample) => {
    const { service, client } = makeService({
      info: primaryInfo(100_000_000, 50_000_000),
      samples: [sample],
    });
    const result = await evaluateSettled(service);
    expect(client.getInfoParsed).toHaveBeenCalledTimes(2);
    expect(result.signals.replicationLagBytes).toBe(50_000_000);
    expect(result).toMatchObject({ allow: false, skipReason: 'replication_lag_elevated' });
  });

  it('follows a replica by address when the slaveN lines renumber', async () => {
    const { service } = makeService({
      info: makeInfo({
        role: 'master',
        master_repl_offset: '100000000',
        replicas: {
          slave0: 'ip=10.0.0.2,port=6379,state=online,offset=50000000,lag=0',
          slave1: 'ip=10.0.0.3,port=6379,state=online,offset=60000000,lag=0',
        },
      }),
      samples: [
        makeInfo({
          role: 'master',
          master_repl_offset: '101000000',
          replicas: { slave0: 'ip=10.0.0.3,port=6379,state=online,offset=99000000,lag=0' },
        }),
      ],
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBe(50_000_000);
    expect(result).toMatchObject({ allow: false, skipReason: 'replication_lag_elevated' });
  });

  it('keeps the furthest replica when two report the same address', async () => {
    const { service } = makeService({
      info: makeInfo({
        role: 'master',
        master_repl_offset: '100000000',
        replicas: {
          slave0: 'ip=10.0.0.2,port=6379,state=online,offset=99000000,lag=0',
          slave1: 'ip=10.0.0.2,port=6379,state=online,offset=50000000,lag=0',
        },
      }),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBe(50_000_000);
  });

  it('waits only for the replicas at or above the limit', async () => {
    const { service, client } = makeService({
      info: primaryInfo(100_000_000, 95_000_000, 50_000_000),
      samples: [primaryInfo(101_000_000, 95_000_000, 99_000_000)],
    });
    const result = await evaluateSettled(service);
    expect(client.getInfoParsed).toHaveBeenCalledTimes(2);
    expect(result.signals.replicationLagBytes).toBe(5_000_000);
    expect(result.allow).toBe(true);
  });

  it('falls back to the baseline gap when a later sample fails', async () => {
    const { service, client } = makeService({
      info: primaryInfo(100_000_000, 50_000_000),
      samples: [new Error('connection lost')],
    });
    const result = await evaluateSettled(service);
    expect(client.getInfoParsed).toHaveBeenCalledTimes(2);
    expect(result.signals.replicationLagBytes).toBe(50_000_000);
    expect(result).toMatchObject({ allow: false, skipReason: 'replication_lag_elevated' });
  });

  it('falls back to the baseline gap when the connection is removed mid-wait', async () => {
    const { service, registry } = makeService({ info: primaryInfo(100_000_000, 50_000_000) });
    const pending = service.evaluate(CONNECTION_ID);
    await jest.advanceTimersByTimeAsync(0);
    (registry.get as jest.Mock).mockImplementation(() => {
      throw new Error('Connection not found');
    });
    await jest.runAllTimersAsync();
    const result = await pending;
    expect(result.signals.replicationLagBytes).toBe(50_000_000);
  });

  it('asks a fresh client for the replication section on each later sample', async () => {
    const { service, client, registry } = makeService({
      info: primaryInfo(100_000_000, 50_000_000),
    });
    const replacement = {
      getInfoParsed: jest.fn().mockResolvedValue(primaryInfo(101_000_000, 100_000_000)),
    };
    const pending = service.evaluate(CONNECTION_ID);
    await jest.advanceTimersByTimeAsync(0);
    (registry.get as jest.Mock).mockReturnValue(replacement);
    await jest.runAllTimersAsync();
    await pending;
    expect(client.getInfoParsed).toHaveBeenCalledTimes(2);
    expect(client.getInfoParsed).toHaveBeenNthCalledWith(1, ['memory', 'replication']);
    expect(client.getInfoParsed).toHaveBeenNthCalledWith(2, ['replication']);
    expect(replacement.getInfoParsed).toHaveBeenCalledWith(['replication']);
  });

  it('measures an ack against the primary offset read with it', async () => {
    const { service } = makeService({
      info: primaryInfo(100_000_000, 50_000_000),
      samples: [primaryInfo(100_000_000, 50_000_000), primaryInfo(130_000_000, 60_000_000)],
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBe(70_000_000);
  });

  it('answers an advisory read without waiting for acks', async () => {
    const { service, client } = makeService({ info: primaryInfo(100_000_000, 50_000_000) });
    await service.evaluateAdvisory(CONNECTION_ID);
    expect(client.getInfoParsed).toHaveBeenCalledTimes(1);
  });

  it('keeps an unsettled gap visible and unconfirmed on an advisory read', async () => {
    const { service } = makeService({ info: primaryInfo(600_000_000, 100_000_000) });
    const result = await service.evaluateAdvisory(CONNECTION_ID);
    expect(result).toMatchObject({ allow: true, lagUnconfirmed: true });
    expect(result.skipReason).toBeUndefined();
    expect(result.signals.replicationLagBytes).toBe(500_000_000);
  });

  it('does not mark a gap under the limit as unconfirmed', async () => {
    const { service } = makeService({ info: primaryInfo(100_000_000, 95_000_000) });
    const result = await service.evaluateAdvisory(CONNECTION_ID);
    expect(result.lagUnconfirmed).toBeUndefined();
  });

  it('waits for a fresh ack when a moved ack is still over the limit', async () => {
    const { service } = makeService({
      info: primaryInfo(100_000_000, 70_000_000),
      samples: [primaryInfo(130_000_000, 100_000_000)],
      nextInfo: primaryInfo(131_000_000, 130_000_000),
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBe(1_000_000);
    expect(result.allow).toBe(true);
  });

  it('keeps the latest gap when no fresh ack follows a moved ack', async () => {
    const { service } = makeService({
      info: primaryInfo(100_000_000, 70_000_000),
      samples: [primaryInfo(130_000_000, 100_000_000)],
    });
    const result = await evaluateSettled(service);
    expect(result.signals.replicationLagBytes).toBe(30_000_000);
    expect(result.allow).toBe(false);
  });

  it('keeps other advisory findings when the gap is unsettled', async () => {
    const { service } = makeService({
      info: makeInfo({
        used_memory: '9900',
        master_repl_offset: '100000000',
        replicas: { slave0: 'ip=10.0.0.2,port=6379,state=online,offset=50000000,lag=0' },
      }),
    });
    await expect(service.evaluateAdvisory(CONNECTION_ID)).resolves.toMatchObject({
      allow: false,
      skipReason: 'memory_above_threshold',
    });
  });

  it('polls for an ack no more than every 250ms', async () => {
    const { service, client } = makeService({ info: primaryInfo(100_000_000, 50_000_000) });
    await evaluateSettled(service);
    expect(client.getInfoParsed.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it('logs the measured lag rather than the baseline gap', async () => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    const { service } = makeService({
      info: primaryInfo(100_000_000, 50_000_000),
      samples: [primaryInfo(100_000_000, 50_000_000), primaryInfo(101_000_000, 60_000_000)],
    });
    await evaluateSettled(service);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('"replicationLagBytes":41000000'));
  });

  describe('overlapping evaluations', () => {
    const lagging = () => primaryInfo(100_000_000, 50_000_000);
    const countPolls = (client: { getInfoParsed: jest.Mock }) =>
      client.getInfoParsed.mock.calls.filter(([sections]) => sections?.length === 1).length;

    async function countPollsOfOneEvaluation(): Promise<number> {
      const { service, client } = makeService({ info: lagging() });
      await evaluateSettled(service);
      return countPolls(client);
    }

    it('share one measurement on the same connection', async () => {
      const { service, client } = makeService({ info: lagging() });
      const pending = [1, 2, 3].map(() => service.evaluate(CONNECTION_ID));
      await jest.runAllTimersAsync();
      const results = await Promise.all(pending);
      expect(countPolls(client)).toBe(await countPollsOfOneEvaluation());
      for (const result of results) {
        expect(result.signals.replicationLagBytes).toBe(50_000_000);
      }
    });

    it('reuse the result within its lifetime', async () => {
      const { service, client } = makeService({ info: lagging() });
      await evaluateSettled(service);
      await evaluateSettled(service);
      expect(countPolls(client)).toBe(await countPollsOfOneEvaluation());
    });

    it('give up on a read that hangs and let the next one through', async () => {
      const { service, client } = makeService({ info: makeInfo() });
      client.getInfoParsed.mockReset();
      client.getInfoParsed.mockReturnValueOnce(new Promise(() => undefined));
      client.getInfoParsed.mockResolvedValue(makeInfo());
      const hung = expect(service.evaluate(CONNECTION_ID)).rejects.toThrow('timed out');
      await jest.advanceTimersByTimeAsync(5_000);
      await hung;
      await expect(service.evaluate(CONNECTION_ID)).resolves.toMatchObject({ allow: true });
    });

    it('do not keep a failed evaluation', async () => {
      const { service, registry } = makeService({ info: makeInfo() });
      (registry.get as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Connection not found');
      });
      await expect(service.evaluate(CONNECTION_ID)).rejects.toThrow('Connection not found');
      await expect(service.evaluate(CONNECTION_ID)).resolves.toMatchObject({ allow: true });
    });

    it('measure each connection on its own', async () => {
      const { service, client } = makeService({ info: lagging() });
      const pending = [service.evaluate('conn-1'), service.evaluate('conn-2')];
      await jest.runAllTimersAsync();
      await Promise.all(pending);
      expect(countPolls(client)).toBe(2 * (await countPollsOfOneEvaluation()));
    });

    it('measure again once the result has expired', async () => {
      const { service, client } = makeService({ info: lagging() });
      await evaluateSettled(service);
      await jest.advanceTimersByTimeAsync(1_000);
      await evaluateSettled(service);
      expect(countPolls(client)).toBe(2 * (await countPollsOfOneEvaluation()));
    });
  });

  describe('with a lag limit of 0', () => {
    const config = { MONITOR_REPLICATION_LAG_BYTES: 0 };

    it('keeps the lag of a primary without replicas at 0', async () => {
      const { service, client } = makeService({ info: primaryInfo(100_000_000), config });
      const result = await service.evaluate(CONNECTION_ID);
      expect(client.getInfoParsed).toHaveBeenCalledTimes(1);
      expect(result.signals.replicationLagBytes).toBe(0);
      expect(result.allow).toBe(true);
    });

    it('does not wait for a replica that is already in sync', async () => {
      const { service, client } = makeService({
        info: primaryInfo(100_000_000, 100_000_000),
        config,
      });
      const result = await service.evaluate(CONNECTION_ID);
      expect(client.getInfoParsed).toHaveBeenCalledTimes(1);
      expect(result.signals.replicationLagBytes).toBe(0);
    });

    it('stops waiting once the sample before the polls shows a replica in sync', async () => {
      const { service, client } = makeService({
        info: primaryInfo(100_000_000, 99_000_000, 100_000_000),
        samples: [primaryInfo(100_000_000, 100_000_000, 100_000_000)],
        config,
      });
      const result = await service.evaluate(CONNECTION_ID);
      expect(client.getInfoParsed).toHaveBeenCalledTimes(2);
      expect(result.signals.replicationLagBytes).toBe(0);
    });
  });

  it('takes one sample when the baseline gap is under the limit', async () => {
    const { service, client } = makeService({ info: primaryInfo(100_000_000, 95_000_000) });
    const result = await service.evaluate(CONNECTION_ID);
    expect(client.getInfoParsed).toHaveBeenCalledTimes(1);
    expect(result.signals.replicationLagBytes).toBe(5_000_000);
    expect(result.allow).toBe(true);
  });

  it('takes one sample when another signal already skips the capture', async () => {
    const { service, client } = makeService({
      info: makeInfo({
        role: 'master',
        used_memory: '9000',
        master_repl_offset: '100000000',
        replicas: { slave0: 'ip=10.0.0.2,port=6379,state=online,offset=50000000,lag=0' },
      }),
    });
    const result = await service.evaluate(CONNECTION_ID);
    expect(client.getInfoParsed).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ allow: false, skipReason: 'memory_above_threshold' });
  });

  it('takes one sample when no replica can be measured', async () => {
    const { service, client } = makeService({ info: makeInfo({ role: 'master' }) });
    await evaluateSettled(service);
    expect(client.getInfoParsed).toHaveBeenCalledTimes(1);
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

  it('leaves replicas still in their initial sync out of the lag', async () => {
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

  describe('replica links seen from the primary', () => {
    const replicaLine = (fields: string) => ({ slave0: `ip=10.0.0.2,port=6379,${fields}` });
    const HEALTHY = 'ip=10.0.0.3,port=6379,state=online,offset=1000,lag=0';

    it.each(['wait_bgsave', 'send_bulk', 'send_bulk_and_stream'])(
      'skips when a replica is in %s',
      async (state) => {
        const { service, client } = makeService({
          info: makeInfo({
            role: 'master',
            replicas: { ...replicaLine(`state=${state},offset=0,lag=0`), slave1: HEALTHY },
          }),
        });
        const result = await service.evaluate(CONNECTION_ID);
        expect(client.getInfoParsed).toHaveBeenCalledTimes(1);
        expect(result.signals.replicaLinkDown).toBe(true);
        expect(result).toMatchObject({ allow: false, skipReason: 'replica_link_unhealthy' });
      },
    );

    it('skips when an online replica has stopped acking', async () => {
      const { service } = makeService({
        info: makeInfo({
          role: 'primary',
          replicas: replicaLine('state=online,offset=1000,lag=31'),
        }),
      });
      const result = await evaluateSettled(service);
      expect(result.signals.replicaLinkDown).toBe(true);
      expect(result).toMatchObject({ allow: false, skipReason: 'replica_link_unhealthy' });
    });

    it('reports the link as healthy at the stale limit', async () => {
      const { service } = makeService({
        info: makeInfo({
          role: 'master',
          replicas: replicaLine('state=online,offset=1000,lag=30'),
        }),
      });
      const result = await evaluateSettled(service);
      expect(result.signals.replicaLinkDown).toBe(false);
      expect(result.allow).toBe(true);
    });

    it('uses the configured stale limit', async () => {
      const { service } = makeService({
        info: makeInfo({
          role: 'master',
          replicas: replicaLine('state=online,offset=1000,lag=45'),
        }),
        config: { MONITOR_REPLICA_IO_STALE_SEC: 60 },
      });
      const result = await evaluateSettled(service);
      expect(result.signals.replicaLinkDown).toBe(false);
    });

    it.each([
      ['a SYNC consumer that never acks', 'state=online,offset=0,lag=500'],
      ['a line with no lag', 'state=online,offset=1000'],
      ['a line with an unreadable lag', 'state=online,offset=1000,lag=soon'],
      ['a line with no state', 'offset=1000,lag=0'],
    ])('reports the link as unknown for %s', async (_name, fields) => {
      const { service } = makeService({
        info: makeInfo({ role: 'master', replicas: replicaLine(fields) }),
      });
      const result = await evaluateSettled(service);
      expect(result.signals.replicaLinkDown).toBeNull();
      expect(result.allow).toBe(true);
    });

    it('reports the link as unknown when connected replicas have no lines', async () => {
      const { service } = makeService({
        info: makeInfo({ role: 'master', connected_slaves: '2' }),
      });
      const result = await evaluateSettled(service);
      expect(result.signals.replicaLinkDown).toBeNull();
    });

    it('skips a chained replica whose own replica is in a resync', async () => {
      const { service } = makeService({
        info: makeInfo({
          role: 'slave',
          master_link_status: 'up',
          master_sync_in_progress: '0',
          master_last_io_seconds_ago: '1',
          replicas: replicaLine('state=send_bulk,offset=0,lag=0'),
        }),
      });
      const result = await evaluateSettled(service);
      expect(result.signals.replicaLinkDown).toBe(true);
      expect(result).toMatchObject({ allow: false, skipReason: 'replica_link_unhealthy' });
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
