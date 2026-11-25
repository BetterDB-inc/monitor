/* eslint-disable @typescript-eslint/no-explicit-any */
import { Test, TestingModule } from '@nestjs/testing';
import {
  LatencyRegressionService,
  latencyRegressionIgnoreCommands,
} from '../latency-regression.service';
import { ADMIN_COMMANDS } from '../regression-detector';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { ConnectionContext } from '@app/common/services/multi-connection-poller';
import { WEBHOOK_EVENTS_PRO_SERVICE } from '@betterdb/shared';
import { ANOMALY_EVENT_SINK } from '../../anomaly-detection/types';

const START = 1_700_000_000_000;
const MINUTE = 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('LatencyRegressionService', () => {
  let now: number;
  let samples: any[];
  let storage: any;
  let webhook: { dispatchLatencyRegressionDetected: jest.Mock };
  let client: { getConfigValue: jest.Mock };

  const ctx = (): ConnectionContext => ({
    connectionId: 'conn-1',
    connectionName: 'test',
    client: client as any,
    host: 'h',
    port: 6379,
  });

  const mkSample = (p99Us: number, serverVersion: string) => ({
    id: `${samples.length}`,
    connectionId: 'conn-1',
    command: 'hmget',
    p50Us: 0,
    p99Us,
    p999Us: 0,
    serverVersion,
    capturedAt: now,
  });

  beforeEach(() => {
    now = START;
    samples = [];
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    storage = {
      getLatencyStatsHistory: jest.fn().mockImplementation(async () => [...samples]),
      // A full ~10-min buffer: 10 one-minute samples at 120 calls/min each → 120 calls/min.
      getCommandStatsHistory: jest.fn().mockImplementation(async ({ command }: any) =>
        command === 'hmget'
          ? Array.from({ length: 10 }, (_, i) => ({ callsDelta: 120, capturedAt: now - i * MINUTE }))
          : [],
      ),
      saveAnomalyEvent: jest.fn().mockResolvedValue('saved'),
      // No histogram rows by default: the cumulative latencystats path.
      getLatencyHistograms: jest.fn().mockResolvedValue([]),
    };
    webhook = {
      dispatchLatencyRegressionDetected: jest.fn().mockResolvedValue(undefined),
    };
    client = { getConfigValue: jest.fn().mockResolvedValue('16') };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function makeService(
    withWebhook = true,
    sink?: { ingestExternalAnomaly: jest.Mock; stampExternalAnomaly?: jest.Mock },
  ): Promise<LatencyRegressionService> {
    const providers: any[] = [
      LatencyRegressionService,
      { provide: 'STORAGE_CLIENT', useValue: storage },
      { provide: ConnectionRegistry, useValue: { list: jest.fn().mockReturnValue([]) } },
    ];
    if (withWebhook) {
      providers.push({ provide: WEBHOOK_EVENTS_PRO_SERVICE, useValue: webhook });
    }
    if (sink) {
      providers.push({ provide: ANOMALY_EVENT_SINK, useValue: sink });
    }
    const module: TestingModule = await Test.createTestingModule({ providers }).compile();
    return module.get(LatencyRegressionService);
  }

  async function poll(service: LatencyRegressionService, p99Us: number, version: string) {
    now += MINUTE;
    samples.push(mkSample(p99Us, version));
    await (service as any).pollConnection(ctx());
  }

  async function driveUpgradeRegression(service: LatencyRegressionService) {
    for (let i = 0; i < 6; i++) await poll(service, 2000, '8.1.0');
    for (let i = 0; i < 5; i++) await poll(service, 6000, '9.0.0');
  }

  it('persists one command_p99 anomaly event and dispatches one webhook per upgrade window', async () => {
    const service = await makeService();
    await driveUpgradeRegression(service);

    expect(storage.saveAnomalyEvent).toHaveBeenCalledTimes(1);
    const [event, connId] = storage.saveAnomalyEvent.mock.calls[0];
    expect(connId).toBe('conn-1');
    expect(event.id).toMatch(UUID_RE);
    expect(event.commands).toEqual(['hmget']);
    expect(event).toMatchObject({
      metricType: 'command_p99',
      kind: 'upgrade_regression',
      anomalyType: 'spike',
      severity: 'critical', // 3x factor
      value: 6000,
      baseline: 2000,
      resolved: false,
      connectionId: 'conn-1',
      sourceHost: 'h',
      sourcePort: 6379,
    });
    expect(event.message).toContain('hmget');

    expect(webhook.dispatchLatencyRegressionDetected).toHaveBeenCalledTimes(1);
    const payload = webhook.dispatchLatencyRegressionDetected.mock.calls[0][0];
    expect(payload).toMatchObject({
      kind: 'upgrade_regression',
      previousVersion: '8.1.0',
      currentVersion: '9.0.0',
      prefetchBatchMaxSize: 16,
      connectionId: 'conn-1',
      instance: { host: 'h', port: 6379 },
    });
    expect(payload.commands[0]).toMatchObject({ command: 'hmget', callsPerMin: 120 });
    expect(payload.runbook.join(' ')).toContain('prefetch-batch-max-size');

    // One-shot: continued degradation does not re-fire
    for (let i = 0; i < 5; i++) await poll(service, 6000, '9.0.0');
    expect(storage.saveAnomalyEvent).toHaveBeenCalledTimes(1);
    expect(webhook.dispatchLatencyRegressionDetected).toHaveBeenCalledTimes(1);
  });

  it('does not under-report call rate from a partly-filled buffer (volume gate)', async () => {
    // Only 3 samples exist (buffer not yet full), each at 100 calls/min. The rate is 100/min,
    // above the 60/min gate. Dividing by the fixed 10-min window would read this as 30/min and
    // wrongly exclude the command, so no regression would ever be evaluated.
    storage.getCommandStatsHistory = jest.fn().mockImplementation(async ({ command }: any) =>
      command === 'hmget'
        ? Array.from({ length: 3 }, (_, i) => ({ callsDelta: 100, capturedAt: now - i * MINUTE }))
        : [],
    );

    const service = await makeService();
    await driveUpgradeRegression(service);

    expect(storage.saveAnomalyEvent).toHaveBeenCalledTimes(1);
    const payload = webhook.dispatchLatencyRegressionDetected.mock.calls[0][0];
    expect(payload.commands[0]).toMatchObject({ command: 'hmget', callsPerMin: 100 });
  });

  it('reads prefetch-batch-max-size via CONFIG GET on Valkey 9+', async () => {
    const service = await makeService();
    await driveUpgradeRegression(service);

    expect(client.getConfigValue).toHaveBeenCalledWith('prefetch-batch-max-size');
  });

  it('sets prefetchBatchMaxSize to null when CONFIG GET fails (ACL-restricted)', async () => {
    client.getConfigValue.mockRejectedValue(new Error('NOPERM'));
    const service = await makeService();
    await driveUpgradeRegression(service);

    const payload = webhook.dispatchLatencyRegressionDetected.mock.calls[0][0];
    expect(payload.prefetchBatchMaxSize).toBeNull();
  });

  it('still persists the anomaly event when no webhook service is wired (community build)', async () => {
    const service = await makeService(false);
    await driveUpgradeRegression(service);

    expect(storage.saveAnomalyEvent).toHaveBeenCalledTimes(1);
    expect(webhook.dispatchLatencyRegressionDetected).not.toHaveBeenCalled();
  });

  it('hands the persisted event, unchanged, to the anomaly event sink', async () => {
    const sink = { ingestExternalAnomaly: jest.fn() };
    const service = await makeService(true, sink);
    await driveUpgradeRegression(service);

    expect(sink.ingestExternalAnomaly).toHaveBeenCalledTimes(1);
    expect(sink.ingestExternalAnomaly.mock.calls[0][0]).toBe(storage.saveAnomalyEvent.mock.calls[0][0]);
  });

  it('lets the anomaly event sink stamp the event before it is saved', async () => {
    const sink = {
      ingestExternalAnomaly: jest.fn(),
      stampExternalAnomaly: jest.fn((event: any) => {
        event.eventSequence = 7;
        event.scopeId = 'conn-1';
      }),
    };
    storage.saveAnomalyEvent.mockImplementation(async (event: any) => {
      expect(event).toEqual(expect.objectContaining({ eventSequence: 7, scopeId: 'conn-1' }));
    });
    const service = await makeService(true, sink);
    await driveUpgradeRegression(service);

    expect(sink.stampExternalAnomaly).toHaveBeenCalledTimes(1);
    expect(storage.saveAnomalyEvent).toHaveBeenCalledTimes(1);
    expect(sink.stampExternalAnomaly.mock.invocationCallOrder[0]).toBeLessThan(
      storage.saveAnomalyEvent.mock.invocationCallOrder[0],
    );
  });

  it('still saves and notifies when the sink fails to stamp the event', async () => {
    const sink = {
      ingestExternalAnomaly: jest.fn(),
      stampExternalAnomaly: jest.fn(() => {
        throw new Error('stamp failed');
      }),
    };
    const service = await makeService(true, sink);
    await driveUpgradeRegression(service);

    expect(storage.saveAnomalyEvent).toHaveBeenCalledTimes(1);
    expect(sink.ingestExternalAnomaly).toHaveBeenCalledTimes(1);
    expect(webhook.dispatchLatencyRegressionDetected).toHaveBeenCalledTimes(1);
  });

  it('tells the anomaly event sink whether latency is still degraded after each poll', async () => {
    const sink = { ingestExternalAnomaly: jest.fn(), reportLatencyDegraded: jest.fn() };
    const service = await makeService(true, sink);
    await driveUpgradeRegression(service);

    expect(sink.reportLatencyDegraded).toHaveBeenCalled();
    expect(sink.reportLatencyDegraded.mock.calls.at(-1)).toEqual(['conn-1', true]);
  });

  it('still dispatches the webhook when the anomaly event sink throws', async () => {
    const sink = {
      ingestExternalAnomaly: jest.fn(() => {
        throw new Error('sink failed');
      }),
    };
    const service = await makeService(true, sink);
    await driveUpgradeRegression(service);

    expect(sink.ingestExternalAnomaly).toHaveBeenCalledTimes(1);
    expect(webhook.dispatchLatencyRegressionDetected).toHaveBeenCalledTimes(1);
  });

  it('does not hand an unpersisted event to the anomaly event sink', async () => {
    storage.saveAnomalyEvent.mockRejectedValue(new Error('db down'));
    const sink = { ingestExternalAnomaly: jest.fn() };
    const service = await makeService(true, sink);
    await driveUpgradeRegression(service);

    expect(sink.ingestExternalAnomaly).not.toHaveBeenCalled();
  });

  it('does nothing without stored latencystats samples', async () => {
    const service = await makeService();
    await (service as any).pollConnection(ctx());

    expect(storage.saveAnomalyEvent).not.toHaveBeenCalled();
    expect(storage.getCommandStatsHistory).not.toHaveBeenCalled();
  });

  it('does not dispatch the webhook when persistence fails (no notify without a durable record)', async () => {
    storage.saveAnomalyEvent.mockRejectedValue(new Error('db down'));
    const service = await makeService();
    await driveUpgradeRegression(service);

    expect(storage.saveAnomalyEvent).toHaveBeenCalledTimes(1); // attempted
    expect(webhook.dispatchLatencyRegressionDetected).not.toHaveBeenCalled();
  });

  it('re-emits the regression on the next poll and persists+notifies once storage recovers', async () => {
    // First (and only) fire during the drive fails to persist; the detector is re-armed.
    storage.saveAnomalyEvent.mockRejectedValueOnce(new Error('db down'));
    const service = await makeService();
    await driveUpgradeRegression(service);

    expect(storage.saveAnomalyEvent).toHaveBeenCalledTimes(1);
    expect(webhook.dispatchLatencyRegressionDetected).not.toHaveBeenCalled();

    // Still degraded on the next poll → re-fires; the save now succeeds.
    await poll(service, 6000, '9.0.0');
    expect(storage.saveAnomalyEvent).toHaveBeenCalledTimes(2);
    expect(webhook.dispatchLatencyRegressionDetected).toHaveBeenCalledTimes(1);
  });

  it('passes the ignore list from the environment to its detectors', async () => {
    process.env.LATENCY_REGRESSION_EXTRA_IGNORE_COMMANDS = 'hmget';
    try {
      const service = await makeService();
      await driveUpgradeRegression(service);
    } finally {
      delete process.env.LATENCY_REGRESSION_EXTRA_IGNORE_COMMANDS;
    }

    expect(storage.saveAnomalyEvent).not.toHaveBeenCalled();
    expect(webhook.dispatchLatencyRegressionDetected).not.toHaveBeenCalled();
  });

  it('reports the cumulative basis when the connection has no histogram rows', async () => {
    const service = await makeService();
    await driveUpgradeRegression(service);

    const payload = webhook.dispatchLatencyRegressionDetected.mock.calls[0][0];
    expect(payload.basis).toBe('cumulative');
    expect(storage.getCommandStatsHistory).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'hmget' }),
    );
  });

  it('falls back to the cumulative path when reading histograms fails', async () => {
    storage.getLatencyHistograms.mockRejectedValue(new Error('storage down'));
    const service = await makeService();
    await driveUpgradeRegression(service);

    const payload = webhook.dispatchLatencyRegressionDetected.mock.calls[0][0];
    expect(payload.basis).toBe('cumulative');
  });

  describe('per-interval basis (LATENCY HISTOGRAM deltas)', () => {
    const BUCKETS = [256, 512, 1024, 2048, 4096, 8192];
    const CALLS_PER_MIN = 120;
    let histograms: any[];
    let cumulativeCalls: number;
    let cumulative: Record<string, number>;

    /** Adds one minute of traffic landing in `bucket` (cumulative bucket counts, like the server). */
    function addHistogramMinute(bucket: number) {
      cumulativeCalls += CALLS_PER_MIN;
      for (const b of BUCKETS) cumulative[b] += b >= bucket ? CALLS_PER_MIN : 0;
      histograms.push({
        id: `h${histograms.length}`,
        timestamp: now,
        connectionId: 'conn-1',
        data: { hmget: { calls: cumulativeCalls, histogram: { ...cumulative } } },
      });
    }

    beforeEach(() => {
      histograms = [];
      cumulativeCalls = 0;
      cumulative = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
      // Same semantics as the storage adapters: filter, newest first, limit (default 1).
      storage.getLatencyHistograms.mockImplementation(async (opts: any = {}) =>
        histograms
          .filter(
            (h) =>
              (!opts.startTime || h.timestamp >= opts.startTime) &&
              (!opts.endTime || h.timestamp <= opts.endTime),
          )
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, opts.limit ?? 1),
      );
    });

    async function pollMinute(service: LatencyRegressionService, bucket: number) {
      now += MINUTE;
      samples.push(mkSample(200, '8.1.0')); // cumulative latencystats P99 stays flat
      addHistogramMinute(bucket);
      await (service as any).pollConnection(ctx());
    }

    it('fires on a recent regression the flat cumulative latencystats cannot see, with no per-command volume query', async () => {
      const service = await makeService();
      for (let i = 0; i < 60; i++) await pollMinute(service, 256);
      expect(storage.saveAnomalyEvent).not.toHaveBeenCalled();
      // The first poll has one snapshot (no interval yet) and uses the cumulative path; later polls don't.
      storage.getCommandStatsHistory.mockClear();
      for (let i = 0; i < 6; i++) await pollMinute(service, 4096);

      expect(storage.saveAnomalyEvent).toHaveBeenCalledTimes(1);
      const [event] = storage.saveAnomalyEvent.mock.calls[0];
      expect(event).toMatchObject({ kind: 'sustained_degradation', commands: ['hmget'] });
      const payload = webhook.dispatchLatencyRegressionDetected.mock.calls[0][0];
      expect(payload.basis).toBe('interval');
      expect(payload.commands[0].callsPerMin).toBeCloseTo(CALLS_PER_MIN, 6);

      // Volume came from the histogram deltas: only the cluster refresh commands are queried.
      const queried = storage.getCommandStatsHistory.mock.calls.map((c: any[]) => c[0].command);
      expect(queried).not.toContain('hmget');
    });

    it('backfills 24h in pages of 240 snapshots, then reads only newer snapshots', async () => {
      const service = await makeService();
      now = START + 500 * MINUTE;
      for (let i = 0; i < 500; i++) {
        now = START + (i + 1) * MINUTE;
        addHistogramMinute(256);
      }
      samples.push(mkSample(200, '8.1.0'));
      storage.getLatencyHistograms.mockClear();

      await (service as any).pollConnection(ctx());

      const firstPoll = storage.getLatencyHistograms.mock.calls.map((c: any[]) => c[0]);
      expect(firstPoll).toHaveLength(3); // 240 + 240 + 20
      for (const opts of firstPoll) expect(opts).toMatchObject({ connectionId: 'conn-1', limit: 240 });
      expect(firstPoll[0].endTime).toBe(now);
      expect(firstPoll[1].endTime).toBeLessThan(firstPoll[0].endTime);
      expect(firstPoll[2].endTime).toBeLessThan(firstPoll[1].endTime);

      const lastTimestamp = histograms[histograms.length - 1].timestamp;
      storage.getLatencyHistograms.mockClear();
      now += MINUTE;
      samples.push(mkSample(200, '8.1.0'));
      addHistogramMinute(256);
      await (service as any).pollConnection(ctx());

      expect(storage.getLatencyHistograms).toHaveBeenCalledTimes(1);
      expect(storage.getLatencyHistograms.mock.calls[0][0]).toMatchObject({
        connectionId: 'conn-1',
        startTime: lastTimestamp + 1,
        limit: 10,
      });
    });

    it('forgets the interval window when the connection is removed', async () => {
      const service = await makeService();
      await pollMinute(service, 256);
      await pollMinute(service, 256);
      expect((service as any).intervals.has('conn-1')).toBe(true);

      (service as any).onConnectionRemoved('conn-1');

      expect((service as any).intervals.has('conn-1')).toBe(false);
      expect((service as any).basisLogged.has('conn-1')).toBe(false);
    });
  });
});

describe('latencyRegressionIgnoreCommands', () => {
  it('defaults to the built-in admin commands', () => {
    expect(latencyRegressionIgnoreCommands({})).toEqual(new Set(ADMIN_COMMANDS));
  });

  it('replaces the built-in list with LATENCY_REGRESSION_IGNORE_COMMANDS', () => {
    expect(
      latencyRegressionIgnoreCommands({ LATENCY_REGRESSION_IGNORE_COMMANDS: ' INFO , cluster|* ,' }),
    ).toEqual(new Set(['info', 'cluster|*']));
  });

  it('turns the filter off when LATENCY_REGRESSION_IGNORE_COMMANDS is set but empty', () => {
    expect(latencyRegressionIgnoreCommands({ LATENCY_REGRESSION_IGNORE_COMMANDS: '' })).toEqual(
      new Set(),
    );
  });

  it('adds LATENCY_REGRESSION_EXTRA_IGNORE_COMMANDS to whichever list applies', () => {
    const extra = { LATENCY_REGRESSION_EXTRA_IGNORE_COMMANDS: 'my|admincmd' };
    expect(latencyRegressionIgnoreCommands(extra)).toEqual(
      new Set([...ADMIN_COMMANDS, 'my|admincmd']),
    );
    expect(
      latencyRegressionIgnoreCommands({ ...extra, LATENCY_REGRESSION_IGNORE_COMMANDS: '' }),
    ).toEqual(new Set(['my|admincmd']));
  });
});
