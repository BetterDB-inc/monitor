import { randomUUID } from 'crypto';
import type { KeyAnalyticsResult, KeyPatternSnapshot } from '@betterdb/shared';

type Pick = (snapshot: KeyPatternSnapshot) => number | undefined;

export function buildPatternSnapshots(result: KeyAnalyticsResult, timestamp: number): KeyPatternSnapshot[] {
  // `scanned` counts key VISITS, not distinct keys: SCAN can return the same
  // key more than once (rehashing), so during a full scan it usually exceeds
  // the distinct `dbSize`. Per-pattern `stats.count` is inflated by the same
  // duplicate visits, so dividing by scanned/dbSize (which is >1 here) is the
  // correct normalization — it deflates the visit-inflated totals back to a
  // dbSize-consistent estimate (summed over patterns it yields exactly
  // dbSize). Do NOT clamp to 1: that would persist raw visit counts and
  // over-count keys/memory on deep scans.
  const samplingRatio = result.scanned / result.dbSize;

  return result.patterns.map((stats) => {
    const avgMemory = stats.count > 0 ? Math.round(stats.totalMemory / stats.count) : 0;
    const avgIdleTime = stats.count > 0 ? Math.round(stats.totalIdleTime / stats.count) : 0;
    const avgFreq =
      stats.accessFrequencies.length > 0
        ? stats.accessFrequencies.reduce((a, b) => a + b, 0) / stats.accessFrequencies.length
        : undefined;

    const avgTtl =
      stats.ttlValues.length > 0
        ? Math.round(stats.ttlValues.reduce((a, b) => a + b, 0) / stats.ttlValues.length)
        : undefined;
    const minTtl = stats.ttlValues.length > 0 ? Math.min(...stats.ttlValues) : undefined;
    const maxTtl = stats.ttlValues.length > 0 ? Math.max(...stats.ttlValues) : undefined;

    const staleCount = stats.staleCount === undefined ? undefined : Math.round(stats.staleCount / samplingRatio);
    const expiringSoon = stats.ttlValues.filter((t) => t < 3600).length;
    const expiringSoonCount = Math.round((expiringSoon / (stats.ttlValues.length || 1)) * stats.withTtl);

    let hotCount: number | undefined;
    let coldCount: number | undefined;
    if (avgFreq !== undefined) {
      const coldThreshold = avgFreq / 2;
      hotCount = Math.round(
        (stats.accessFrequencies.filter((f) => f > avgFreq).length / stats.count) * stats.count,
      );
      coldCount = Math.round(
        (stats.accessFrequencies.filter((f) => f < coldThreshold).length / stats.count) * stats.count,
      );
    }

    return {
      id: randomUUID(),
      timestamp,
      pattern: stats.pattern,
      keyCount: Math.round(stats.count / samplingRatio),
      sampledKeyCount: stats.count,
      keysWithTtl: Math.round(stats.withTtl / samplingRatio),
      keysExpiringSoon: Math.round(expiringSoonCount / samplingRatio),
      totalMemoryBytes: Math.round(stats.totalMemory / samplingRatio),
      avgMemoryBytes: avgMemory,
      maxMemoryBytes: stats.maxMemory,
      avgAccessFrequency: avgFreq,
      hotKeyCount: hotCount,
      coldKeyCount: coldCount,
      avgIdleTimeSeconds: avgIdleTime,
      staleKeyCount: staleCount,
      avgTtlSeconds: avgTtl,
      minTtlSeconds: minTtl,
      maxTtlSeconds: maxTtl,
    };
  });
}

export function mergePatternSnapshots(perNode: KeyPatternSnapshot[][]): KeyPatternSnapshot[] {
  if (perNode.length === 1) {
    return perNode[0];
  }
  const byPattern = new Map<string, KeyPatternSnapshot[]>();
  for (const snapshot of perNode.flat()) {
    byPattern.set(snapshot.pattern, [...(byPattern.get(snapshot.pattern) ?? []), snapshot]);
  }
  return Array.from(byPattern.values()).map((group) => (group.length === 1 ? group[0] : mergeGroup(group)));
}

function mergeGroup(group: KeyPatternSnapshot[]): KeyPatternSnapshot {
  const defined = (pick: Pick): number[] => group.map(pick).filter((value): value is number => value !== undefined);
  const sum = (pick: Pick): number => defined(pick).reduce((total, value) => total + value, 0);
  const sumIfAny = (pick: Pick): number | undefined => (defined(pick).length > 0 ? sum(pick) : undefined);
  const average = (pick: Pick, weight: Pick): number | undefined => {
    const measured = group.filter((snapshot) => pick(snapshot) !== undefined);
    if (measured.length === 0) {
      return undefined;
    }
    const weights = measured.reduce((total, snapshot) => total + (weight(snapshot) ?? 0), 0);
    if (weights === 0) {
      return measured.reduce((total, snapshot) => total + (pick(snapshot) ?? 0), 0) / measured.length;
    }
    return measured.reduce((total, snapshot) => total + (pick(snapshot) ?? 0) * (weight(snapshot) ?? 0), 0) / weights;
  };
  const rounded = (value: number | undefined): number | undefined => (value === undefined ? undefined : Math.round(value));
  const keyCount: Pick = (snapshot) => snapshot.keyCount;
  const ttlLows = defined((snapshot) => snapshot.minTtlSeconds);
  const ttlHighs = defined((snapshot) => snapshot.maxTtlSeconds);

  return {
    id: randomUUID(),
    timestamp: group[0].timestamp,
    pattern: group[0].pattern,
    keyCount: sum(keyCount),
    sampledKeyCount: sum((snapshot) => snapshot.sampledKeyCount),
    keysWithTtl: sum((snapshot) => snapshot.keysWithTtl),
    keysExpiringSoon: sum((snapshot) => snapshot.keysExpiringSoon),
    totalMemoryBytes: sum((snapshot) => snapshot.totalMemoryBytes),
    avgMemoryBytes: rounded(average((snapshot) => snapshot.avgMemoryBytes, keyCount)) ?? 0,
    maxMemoryBytes: Math.max(...group.map((snapshot) => snapshot.maxMemoryBytes)),
    avgAccessFrequency: average((snapshot) => snapshot.avgAccessFrequency, keyCount),
    hotKeyCount: sumIfAny((snapshot) => snapshot.hotKeyCount),
    coldKeyCount: sumIfAny((snapshot) => snapshot.coldKeyCount),
    avgIdleTimeSeconds: rounded(average((snapshot) => snapshot.avgIdleTimeSeconds, keyCount)),
    staleKeyCount: sumIfAny((snapshot) => snapshot.staleKeyCount),
    avgTtlSeconds: rounded(average((snapshot) => snapshot.avgTtlSeconds, (snapshot) => snapshot.keysWithTtl)),
    minTtlSeconds: ttlLows.length > 0 ? Math.min(...ttlLows) : undefined,
    maxTtlSeconds: ttlHighs.length > 0 ? Math.max(...ttlHighs) : undefined,
  };
}
