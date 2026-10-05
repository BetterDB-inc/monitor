import { Feature } from '@betterdb/shared';
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

function setup(score: number | null, settings: unknown = null, webhooks: unknown = undefined, licensed = true) {
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
  const license = { hasFeature: jest.fn().mockReturnValue(licensed) };
  const service = new ScalingReadinessProService(
    storage as any, readinessService as any, registry as any, webhookPro as any, license as any,
  );
  return { service, storage, readinessService, registry, license, webhookPro: webhookPro as any };
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

  it('stores the row at the compute time', async () => {
    const { service, storage, readinessService } = setup(55);
    readinessService.compute.mockResolvedValue({ ...readiness(55), computedAt: NOW - 30_000 });
    await service.tick();
    expect(storage.saveScalingReadinessScore).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: NOW - 30_000 }),
    );
  });

  it('stores a cached compute once but still checks the alert', async () => {
    const { service, storage, webhookPro } = setup(32);
    await service.tick();
    await service.tick();
    expect(storage.saveScalingReadinessScore).toHaveBeenCalledTimes(1);
    expect(webhookPro.dispatchScalingReadinessLow).toHaveBeenCalledTimes(2);
  });

  it('stores again when the compute time advances', async () => {
    const { service, storage, readinessService } = setup(32);
    await service.tick();
    readinessService.compute.mockResolvedValue({ ...readiness(32), computedAt: NOW + 60_000 });
    await service.tick();
    expect(storage.saveScalingReadinessScore).toHaveBeenCalledTimes(2);
  });

  it('skips the tick without the history license feature', async () => {
    const { service, readinessService, license } = setup(55, null, undefined, false);
    await service.tick();
    expect(license.hasFeature).toHaveBeenCalledWith(Feature.SCALING_READINESS_HISTORY);
    expect(readinessService.compute).not.toHaveBeenCalled();
  });

  it('still alerts when saving the score fails', async () => {
    const { service, storage, webhookPro } = setup(32);
    storage.saveScalingReadinessScore.mockRejectedValue(new Error('disk full'));
    await service.tick();
    expect(webhookPro.dispatchScalingReadinessLow).toHaveBeenCalledTimes(1);
  });

  it('resolves when listing connections throws', async () => {
    const { service, registry, readinessService } = setup(55);
    registry.list.mockImplementation(() => {
      throw new Error('registry down');
    });
    await expect(service.tick()).resolves.toBeUndefined();
    expect(readinessService.compute).not.toHaveBeenCalled();
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
    expect(storage.getScalingReadinessScores).toHaveBeenCalledWith({
      connectionId: 'conn-1', from: 1, to: 10, limit: 50000,
    });
  });

  const row = (i: number, score: number) => ({
    id: `r${i}`, connectionId: 'conn-1', timestamp: i * 60_000, score,
    band: 'green', bindingDimension: 'memory', dimensions: [],
  });

  it('returns rows unchanged when within the point budget', async () => {
    const { service, storage } = setup(55);
    const rows = Array.from({ length: 1000 }, (_, i) => row(i, 50 + (i % 7)));
    storage.getScalingReadinessScores.mockResolvedValue(rows);
    const history = await service.getHistory('conn-1', 0, 1e12);
    expect(history.points.map((p) => p.timestamp)).toEqual(rows.map((r) => r.timestamp));
  });

  it('downsamples long ranges keeping the lowest score per bucket', async () => {
    const { service, storage } = setup(55);
    const rows = Array.from({ length: 3000 }, (_, i) => row(i, i % 3 === 1 ? 10 : 80));
    storage.getScalingReadinessScores.mockResolvedValue(rows);
    const history = await service.getHistory('conn-1', 0, 1e12);
    const points = history.points;
    expect(points.length).toBeLessThanOrEqual(1000);
    expect(points.length).toBeGreaterThan(900);
    const timestamps = points.map((p) => p.timestamp);
    expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps);
    expect(timestamps[0]).toBeLessThanOrEqual(2 * 60_000);
    expect(timestamps[timestamps.length - 1]).toBeGreaterThanOrEqual(2997 * 60_000);
    expect(points.filter((p) => p.score === 10).length).toBeGreaterThan(points.length * 0.9);
  });

  it('keeps the earliest row on equal scores within a bucket', async () => {
    const { service, storage } = setup(55);
    const rows = Array.from({ length: 2000 }, (_, i) => row(i, 60));
    storage.getScalingReadinessScores.mockResolvedValue(rows);
    const { points } = await service.getHistory('conn-1', 0, 1e12);
    expect(points[0].timestamp).toBe(0);
    expect(points.length).toBeLessThanOrEqual(1000);
  });
});
