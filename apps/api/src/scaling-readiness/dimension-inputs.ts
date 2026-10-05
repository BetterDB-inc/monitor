import type { MetricForecast } from '@betterdb/shared';
import type { StoredMemorySnapshot } from '../common/interfaces/storage-port.interface';
import {
  DAY_MS,
  DimensionInput,
  growthHeadroom,
  timeToLimitHeadroom,
  utilizationHeadroom,
  WEEK_MS,
} from './scoring';

export interface SeriesPoint {
  timestamp: number;
  value: number;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${Number(value.toFixed(1))} ${BYTE_UNITS[unit]}`;
}

const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`;

export function memoryInput(latest: StoredMemorySnapshot | undefined): DimensionInput {
  if (!latest) return { excludedReason: 'No memory samples yet' };
  if (!latest.maxmemory) return { excludedReason: 'maxmemory not set' };
  const ratio = latest.usedMemory / latest.maxmemory;
  return {
    score: utilizationHeadroom(ratio, 0.95),
    detail: `${percent(ratio)} of ${formatBytes(latest.maxmemory)}`,
  };
}

export function connectionsInput(
  latest: StoredMemorySnapshot | undefined,
  external: boolean,
): DimensionInput {
  if (latest?.maxclients == null || latest.maxclients <= 0) {
    return { excludedReason: external ? 'Not reported over OTLP' : 'maxclients unavailable' };
  }
  if (latest.connectedClients == null) return { excludedReason: 'No client samples yet' };
  return {
    score: utilizationHeadroom(latest.connectedClients / latest.maxclients, 0.95),
    detail: `${latest.connectedClients} of ${latest.maxclients} clients`,
  };
}

export function cpuInput(
  recent: StoredMemorySnapshot[],
  threads: number,
  threadNote: string | null,
): DimensionInput {
  const samples = recent.map((s) => s.cpuSys + s.cpuUser).filter((total) => total !== 0);
  if (samples.length === 0) return { excludedReason: 'No CPU samples yet' };
  const mean = samples.reduce((sum, total) => sum + total, 0) / samples.length;
  const threadText = `${threads} thread${threads === 1 ? '' : 's'}`;
  return {
    score: utilizationHeadroom(mean / 100 / threads, 0.9),
    detail: `${Math.round(mean)}% CPU across ${threadText}${threadNote ? ` (${threadNote})` : ''}`,
  };
}

export function weeklyGrowthPercent(points: SeriesPoint[]): number | null {
  if (points.length < 2) return null;
  const origin = points[0].timestamp;
  if (points[points.length - 1].timestamp - origin < DAY_MS) return null;
  const n = points.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const p of points) {
    const x = p.timestamp - origin;
    sumX += x;
    sumY += p.value;
    sumXY += x * p.value;
    sumXX += x * x;
  }
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denominator;
  const start = (sumY - slope * sumX) / n;
  const weeklyChange = slope * WEEK_MS;
  if (Math.abs(start) < 1e-9) return weeklyChange > 1e-9 ? Infinity : 0;
  return (weeklyChange / Math.abs(start)) * 100;
}

export function growthInput(points: SeriesPoint[], subject: string): DimensionInput {
  const growth = weeklyGrowthPercent(points);
  if (growth === null) return { excludedReason: 'Needs 24h of history' };
  if (growth <= 0) return { score: 100, detail: `${subject} flat or shrinking week over week` };
  return {
    score: growthHeadroom(growth),
    detail: Number.isFinite(growth)
      ? `${subject} growing ${Math.round(growth)}% per week`
      : `${subject} growing from zero`,
  };
}

export function forecastInput(forecast: MetricForecast | null): DimensionInput | null {
  if (!forecast || !forecast.enabled || forecast.insufficientData) return null;
  if (forecast.mode !== 'forecast' || forecast.ceiling === null) return null;
  if (forecast.timeToLimitMs === null) {
    return { score: 100, detail: 'Not projected to reach the ops/sec ceiling' };
  }
  if (forecast.timeToLimitMs <= 0) return { score: 0, detail: 'Ops/sec ceiling already exceeded' };
  return {
    score: timeToLimitHeadroom(forecast.timeToLimitMs),
    detail: `${forecast.timeToLimitHuman} to the ops/sec ceiling`,
  };
}
