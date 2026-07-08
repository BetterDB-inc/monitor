/* eslint-disable @typescript-eslint/no-explicit-any */
import { Test, TestingModule } from '@nestjs/testing';
import { LatencyRegressionService } from '../latency-regression.service';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { ConnectionContext } from '@app/common/services/multi-connection-poller';
import { WEBHOOK_EVENTS_PRO_SERVICE } from '@betterdb/shared';

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
    };
    webhook = {
      dispatchLatencyRegressionDetected: jest.fn().mockResolvedValue(undefined),
    };
    client = { getConfigValue: jest.fn().mockResolvedValue('16') };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function makeService(withWebhook = true): Promise<LatencyRegressionService> {
    const providers: any[] = [
      LatencyRegressionService,
      { provide: 'STORAGE_CLIENT', useValue: storage },
      { provide: ConnectionRegistry, useValue: { list: jest.fn().mockReturnValue([]) } },
    ];
    if (withWebhook) {
      providers.push({ provide: WEBHOOK_EVENTS_PRO_SERVICE, useValue: webhook });
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
    expect(event).toMatchObject({
      metricType: 'command_p99',
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
});
