import { CEILING_RESOLVERS } from '../ceiling-resolvers';
import type { MetricForecastSettings } from '@betterdb/shared';
import type { StoredMemorySnapshot } from '../../common/interfaces/storage-port.interface';

function makeSettings(overrides?: Partial<MetricForecastSettings>): MetricForecastSettings {
  return {
    connectionId: 'conn-1',
    metricKind: 'opsPerSec',
    enabled: true,
    ceiling: null,
    rollingWindowMs: 21600000,
    alertThresholdMs: 7200000,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeSnapshot(overrides?: Partial<StoredMemorySnapshot>): StoredMemorySnapshot {
  return {
    id: 'snap-1',
    timestamp: Date.now(),
    usedMemory: 50_000_000,
    usedMemoryRss: 60_000_000,
    usedMemoryPeak: 70_000_000,
    memFragmentationRatio: 1.2,
    maxmemory: 0,
    allocatorFragRatio: 1.0,
    opsPerSec: 10_000,
    cpuSys: 1.0,
    cpuUser: 2.0,
    ioThreadedReads: 0,
    ioThreadedWrites: 0,
    connectionId: 'conn-1',
    ...overrides,
  };
}

describe('CEILING_RESOLVERS', () => {
  describe('opsPerSec', () => {
    it('returns user-configured ceiling', () => {
      expect(CEILING_RESOLVERS.opsPerSec(makeSettings({ ceiling: 80_000 }))).toBe(80_000);
    });

    it('returns null when no ceiling configured', () => {
      expect(CEILING_RESOLVERS.opsPerSec(makeSettings({ ceiling: null }))).toBeNull();
    });
  });

  describe('usedMemory', () => {
    it('returns user-configured ceiling when set', () => {
      const settings = makeSettings({ metricKind: 'usedMemory', ceiling: 200_000_000 });
      expect(CEILING_RESOLVERS.usedMemory(settings, makeSnapshot())).toBe(200_000_000);
    });

    it('auto-detects from maxmemory when ceiling is null', () => {
      const settings = makeSettings({ metricKind: 'usedMemory', ceiling: null });
      const snapshot = makeSnapshot({ maxmemory: 100_000_000 });
      expect(CEILING_RESOLVERS.usedMemory(settings, snapshot)).toBe(100_000_000);
    });

    it('returns null when ceiling is null and maxmemory is 0', () => {
      const settings = makeSettings({ metricKind: 'usedMemory', ceiling: null });
      const snapshot = makeSnapshot({ maxmemory: 0 });
      expect(CEILING_RESOLVERS.usedMemory(settings, snapshot)).toBeNull();
    });

    it('returns null when ceiling is null and no snapshot', () => {
      const settings = makeSettings({ metricKind: 'usedMemory', ceiling: null });
      expect(CEILING_RESOLVERS.usedMemory(settings)).toBeNull();
    });
  });

  describe('cpuTotal', () => {
    it('returns user-configured ceiling', () => {
      expect(CEILING_RESOLVERS.cpuTotal(makeSettings({ ceiling: 80 }))).toBe(80);
    });

    it('defaults to 100 when no ceiling configured', () => {
      expect(CEILING_RESOLVERS.cpuTotal(makeSettings({ ceiling: null }))).toBe(100);
    });

    it('ceiling of 0 returns 0 (not default)', () => {
      expect(CEILING_RESOLVERS.cpuTotal(makeSettings({ ceiling: 0 }))).toBe(0);
    });
  });

  describe('memFragmentation', () => {
    it('returns user-configured ceiling', () => {
      expect(CEILING_RESOLVERS.memFragmentation(makeSettings({ ceiling: 2.0 }))).toBe(2.0);
    });

    it('defaults to 1.5 when no ceiling configured', () => {
      expect(CEILING_RESOLVERS.memFragmentation(makeSettings({ ceiling: null }))).toBe(1.5);
    });

    it('ceiling of 0 returns 0 (not default)', () => {
      expect(CEILING_RESOLVERS.memFragmentation(makeSettings({ ceiling: 0 }))).toBe(0);
    });
  });
});
