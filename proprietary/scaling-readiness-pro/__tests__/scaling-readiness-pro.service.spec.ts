import { ScalingReadinessProService } from '../scaling-readiness-pro.service';

const NOW = 1_700_000_000_000;

const readiness = (score: number | null) => ({
  connectionId: 'conn-1',
  computedAt: NOW,
  score,
  band: score === null ? null : score >= 70 ? 'green' : score >= 40 ? 'yellow' : 'red',
  bindingDimension: score === null ? null : 'memory',
  summary: score === null ? 'Not enough data yet' : 'Memory is your binding constraint (91% of 4 GB).',
  cappedBy: null,
  dimensions: [{ key: 'memory', score: 12, weight: 30, contribution: 3.6, detail: 'd', excludedReason: null }],
});

function setup(score: number | null, settings: unknown = null, webhooks: unknown = undefined) {
  const storage = {
    saveScalingReadinessScore: jest.fn().mockResolvedValue(undefined),
    getScalingReadinessScores: jest.fn().mockResolvedValue([]),
    getScalingReadinessSettings: jest.fn().mockResolvedValue(settings),
    saveScalingReadinessSettings: jest.fn().mockImplementation(async (s) => s),
  };
  const readinessService = { compute: jest.fn().mockResolvedValue(readiness(score)) };
  const registry = {
    list: jest.fn().mockReturnValue([
      { id: 'conn-1', isConnected: true },
      { id: 'conn-2', isConnected: false },
    ]),
    getConfig: jest.fn().mockReturnValue({ host: 'h', port: 6379 }),
  };
  const webhookPro = webhooks === undefined
    ? { dispatchScalingReadinessLow: jest.fn().mockResolvedValue(undefined) }
    : webhooks;
  const service = new ScalingReadinessProService(
    storage as any, readinessService as any, registry as any, webhookPro as any,
  );
  return { service, storage, readinessService, webhookPro: webhookPro as any };
}

describe('ScalingReadinessProService', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(NOW));
  afterEach(() => jest.useRealTimers());

  it('stores a score row per connected connection', async () => {
    const { service, storage, readinessService } = setup(55);
    await service.tick();
    expect(readinessService.compute).toHaveBeenCalledTimes(1);
    expect(readinessService.compute).toHaveBeenCalledWith('conn-1');
    expect(storage.saveScalingReadinessScore).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'conn-1', timestamp: NOW, score: 55, band: 'yellow', bindingDimension: 'memory' }),
    );
  });

  it('skips null scores', async () => {
    const { service, storage, webhookPro } = setup(null);
    await service.tick();
    expect(storage.saveScalingReadinessScore).not.toHaveBeenCalled();
    expect(webhookPro.dispatchScalingReadinessLow).not.toHaveBeenCalled();
  });

  it('offers every scored tick to the alert with default settings', async () => {
    const { service, webhookPro } = setup(32);
    await service.tick();
    expect(webhookPro.dispatchScalingReadinessLow).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'conn-1', score: 32, threshold: 40, band: 'red',
        dimensions: [{ key: 'memory', score: 12, excludedReason: null }],
        instance: { host: 'h', port: 6379 },
      }),
    );
  });

  it('does not alert when alerts are disabled for the connection', async () => {
    const { service, webhookPro } = setup(10, {
      connectionId: 'conn-1', alertEnabled: false, alertThreshold: 40, updatedAt: 1,
    });
    await service.tick();
    expect(webhookPro.dispatchScalingReadinessLow).not.toHaveBeenCalled();
  });

  it('does not run overlapping ticks', async () => {
    const { service, readinessService } = setup(55);
    let release!: () => void;
    readinessService.compute.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve(readiness(55)); }),
    );
    const first = service.tick();
    await service.tick();
    release();
    await first;
    expect(readinessService.compute).toHaveBeenCalledTimes(1);
  });

  it('returns default settings without persisting on read', async () => {
    const { service, storage } = setup(55);
    expect(await service.getSettings('conn-1')).toEqual({
      connectionId: 'conn-1', alertEnabled: true, alertThreshold: 40, updatedAt: NOW,
    });
    expect(storage.saveScalingReadinessSettings).not.toHaveBeenCalled();
  });

  it('merges and saves settings updates', async () => {
    const { service, storage } = setup(55);
    const saved = await service.updateSettings('conn-1', { alertThreshold: 55 });
    expect(saved).toEqual({ connectionId: 'conn-1', alertEnabled: true, alertThreshold: 55, updatedAt: NOW });
    expect(storage.saveScalingReadinessSettings).toHaveBeenCalledWith(saved);
  });

  it('maps stored rows to history points', async () => {
    const { service, storage } = setup(55);
    storage.getScalingReadinessScores.mockResolvedValue([
      { id: 'r', connectionId: 'conn-1', timestamp: 5, score: 60, band: 'yellow', bindingDimension: 'cpu', dimensions: [] },
    ]);
    expect(await service.getHistory('conn-1', 1, 10)).toEqual({
      points: [{ timestamp: 5, score: 60, band: 'yellow', bindingDimension: 'cpu', dimensions: [] }],
    });
    expect(storage.getScalingReadinessScores).toHaveBeenCalledWith({ connectionId: 'conn-1', from: 1, to: 10 });
  });
});
