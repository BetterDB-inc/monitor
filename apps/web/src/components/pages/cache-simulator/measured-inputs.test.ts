import { describe, it, expect } from 'vitest';
import type { CacheSimulatorSnapshot } from '@betterdb/shared';
import { isSetupFailure, keepPreviousEstimate, measuredInputs, projectionInputs } from './measured-inputs';

const snapshot: CacheSimulatorSnapshot = {
  status: 'ready',
  progress: null,
  instant: { usedMemory: 1_000_000, maxmemory: 2_000_000, maxmemoryPolicy: 'allkeys-lru', totalKeys: 1000 },
  estimate: { totalBytes: 500_000, ci95Bytes: 1000, avgKeyBytes: 500, stdKeyBytes: 40, sampleCount: 400, byType: [], sampledAt: 1, partial: false },
  growth: { keysPerDay: 25, bytesPerDay: 12_000, days: 30 },
};

describe('measured inputs', () => {
  it('prefills from the sampled snapshot', () => {
    expect(measuredInputs(snapshot)).toEqual({ keysPerDay: 25, inPlaceBytesPerDay: 0, ttlDays: null, avgKeyBytes: 500, overheadPerKeyBytes: 0, maxmemory: 2_000_000 });
  });

  it('falls back to INFO averages and zero growth', () => {
    const result = measuredInputs({ ...snapshot, estimate: null, growth: null });
    expect(result.avgKeyBytes).toBe(1000 - 88);
    expect(result.overheadPerKeyBytes).toBe(88);
    expect(result.keysPerDay).toBe(0);
    expect(result.inPlaceBytesPerDay).toBe(0);
  });

  it('starts the projection at used memory when sizes are sampled', () => {
    const result = projectionInputs(snapshot, measuredInputs(snapshot), 30);
    expect(result.currentKeys * (result.avgKeyBytes + result.overheadPerKeyBytes) + result.fixedOverheadBytes).toBe(snapshot.instant.usedMemory);
  });

  it('prefills in-place growth from the byte trend new keys do not explain', () => {
    expect(measuredInputs({ ...snapshot, growth: { keysPerDay: 10, bytesPerDay: 8000, days: 30 } }).inPlaceBytesPerDay).toBe(3000);
  });

  it('rounds the measured key size to whole bytes', () => {
    expect(measuredInputs({ ...snapshot, estimate: { ...snapshot.estimate!, avgKeyBytes: 1607.56 } }).avgKeyBytes).toBe(1608);
  });

  it('never prefills a negative key size', () => {
    expect(measuredInputs({ ...snapshot, estimate: null, instant: { ...snapshot.instant, usedMemory: 10 } }).avgKeyBytes).toBe(0);
  });

  it('builds projection inputs with fixed overhead and band', () => {
    const result = projectionInputs(snapshot, measuredInputs(snapshot), 30);
    expect(result).toMatchObject({ currentKeys: 1000, ci95Bytes: 1000, inPlaceBytesPerDay: 0, horizonDays: 30, maxmemory: 2_000_000 });
    expect(result.fixedOverheadBytes).toBe(1_000_000 - 1000 * 500);
  });

  it('treats maxmemory 0 as no limit', () => {
    expect(projectionInputs(snapshot, { ...measuredInputs(snapshot), maxmemory: 0 }, 30).maxmemory).toBeNull();
  });

  it('detects a setup failure by the zeroed instant figures', () => {
    const zeroed = { usedMemory: 0, maxmemory: 0, maxmemoryPolicy: 'unknown', totalKeys: 0 };
    expect(isSetupFailure({ ...snapshot, status: 'failed', estimate: null, growth: null, instant: zeroed, error: 'down' })).toBe(true);
    expect(isSetupFailure({ ...snapshot, status: 'failed', estimate: null, error: 'ERR' })).toBe(false);
    expect(isSetupFailure({ ...snapshot, status: 'failed', instant: zeroed })).toBe(false);
    expect(isSetupFailure({ ...snapshot, status: 'ready', estimate: null, instant: zeroed })).toBe(false);
  });
});

describe('keepPreviousEstimate', () => {
  const sampling: CacheSimulatorSnapshot = { ...snapshot, status: 'sampling', estimate: null, progress: { sampled: 0, target: 4000 } };

  it('carries the last estimate into a resample that has none yet', () => {
    expect(keepPreviousEstimate(snapshot, sampling)).toEqual({ ...sampling, estimate: snapshot.estimate });
  });

  it('leaves a finished or estimate-bearing snapshot alone', () => {
    const next = { ...snapshot, estimate: { ...snapshot.estimate!, totalBytes: 1 } };
    expect(keepPreviousEstimate(snapshot, next)).toBe(next);
    expect(keepPreviousEstimate(undefined, sampling)).toBe(sampling);
  });
});
