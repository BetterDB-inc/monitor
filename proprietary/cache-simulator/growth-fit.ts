import type { CacheSimulatorGrowth } from '@betterdb/shared';
import type { StoragePort, StoredMemorySnapshot } from '@app/common/interfaces/storage-port.interface';

export const GROWTH_WINDOW_MS = 30 * 86_400_000;
export const MIN_SPAN_MS = 86_400_000;
export const MIN_POINTS = 10;
const DAY_MS = 86_400_000;
const SNAPSHOT_LIMIT = 50_000;

type GrowthPoint = Pick<StoredMemorySnapshot, 'timestamp' | 'usedMemory' | 'totalKeys'>;

export function leastSquaresSlope(points: Array<{ x: number; y: number }>): number {
  const n = points.length;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / n;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / n;
  const covariance = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0);
  const varianceX = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  return varianceX === 0 ? 0 : covariance / varianceX;
}

export function fitGrowth(snapshots: GrowthPoint[]): CacheSimulatorGrowth | null {
  const keyed = snapshots.filter((snapshot) => typeof snapshot.totalKeys === 'number');
  if (keyed.length < MIN_POINTS) return null;
  const first = Math.min(...keyed.map((snapshot) => snapshot.timestamp));
  const last = Math.max(...keyed.map((snapshot) => snapshot.timestamp));
  if (last - first < MIN_SPAN_MS) return null;
  const x = (snapshot: GrowthPoint) => (snapshot.timestamp - first) / DAY_MS;
  return {
    keysPerDay: leastSquaresSlope(keyed.map((snapshot) => ({ x: x(snapshot), y: snapshot.totalKeys as number }))),
    bytesPerDay: leastSquaresSlope(keyed.map((snapshot) => ({ x: x(snapshot), y: snapshot.usedMemory }))),
    days: (last - first) / DAY_MS,
  };
}

export async function readGrowth(storage: StoragePort, connectionId: string, now: number): Promise<CacheSimulatorGrowth | null> {
  try {
    return fitGrowth(
      await storage.getMemorySnapshots({
        connectionId,
        startTime: now - GROWTH_WINDOW_MS,
        endTime: now,
        limit: SNAPSHOT_LIMIT,
      }),
    );
  } catch {
    return null;
  }
}
