import type { BaselineComparison, BaselineMetric, BaselineMetricStatus } from '@betterdb/shared';
import type { StoragePort } from '../../common/interfaces/storage-port.interface';
import type { DatabasePort } from '../../common/interfaces/database-port.interface';

const MIN_SNAPSHOTS = 5;

/**
 * Compare target's current metrics against source's pre-migration baseline.
 * Uses memory snapshots stored by BetterDB before migration started.
 */
export async function compareBaseline(
  storage: StoragePort,
  sourceConnectionId: string,
  targetAdapter: DatabasePort,
  migrationStartedAt: number,
): Promise<BaselineComparison> {
  // 1. Get pre-migration source snapshots
  const snapshots = await storage.getMemorySnapshots({
    connectionId: sourceConnectionId,
    endTime: migrationStartedAt,
    limit: 100,
  });

  // 2. Insufficient data check
  if (snapshots.length < MIN_SNAPSHOTS) {
    return {
      available: false,
      unavailableReason:
        `Insufficient pre-migration data — fewer than ${MIN_SNAPSHOTS} memory snapshots were collected ` +
        'for the source instance before migration started. Connect BetterDB to the source instance ' +
        'earlier next time to establish a baseline.',
      snapshotCount: snapshots.length,
      baselineWindowMs: 0,
      metrics: [],
    };
  }

  // 3. Compute averages from source snapshots
  let sumOps = 0;
  let sumMem = 0;
  let sumFrag = 0;
  let sumCpu = 0;

  for (const snap of snapshots) {
    sumOps += snap.opsPerSec;
    sumMem += snap.usedMemory;
    sumFrag += snap.memFragmentationRatio;
    sumCpu += snap.cpuSys;
  }

  const count = snapshots.length;
  const avgOps = sumOps / count;
  const avgMem = sumMem / count;
  const avgFrag = sumFrag / count;
  const avgCpu = sumCpu / count;

  // 4. Get current target metrics
  const info = await targetAdapter.getInfoParsed(['stats', 'memory', 'cpu']);

  const targetOps = parseFloat(info.stats?.instantaneous_ops_per_sec ?? '0');
  const targetMem = parseFloat(info.memory?.used_memory ?? '0');
  const targetFrag = parseFloat(info.memory?.mem_fragmentation_ratio ?? '0');
  const targetCpu = parseFloat(info.cpu?.used_cpu_sys ?? '0');

  // 5–6. Build metrics with delta and status
  const metrics: BaselineMetric[] = [
    buildMetric('opsPerSec', avgOps, targetOps, (delta) => {
      if (delta > 50) return 'elevated';
      if (delta < -30) return 'degraded';
      return 'normal';
    }),
    buildMetric('usedMemory', avgMem, targetMem, (delta) => {
      if (delta > 20) return 'elevated';
      if (delta < -20) return 'degraded';
      return 'normal';
    }),
    buildMetric('memFragmentationRatio', avgFrag, targetFrag, (_delta, targetValue) => {
      if (targetValue > 1.5) return 'elevated';
      return 'normal';
    }),
    buildMetric('cpuSys', avgCpu, targetCpu, (delta) => {
      if (delta > 50) return 'elevated';
      return 'normal';
    }),
  ];

  // 7. Compute baseline window
  const oldestTimestamp = snapshots[snapshots.length - 1].timestamp;
  const baselineWindowMs = migrationStartedAt - oldestTimestamp;

  return {
    available: true,
    snapshotCount: count,
    baselineWindowMs,
    metrics,
  };
}

function buildMetric(
  name: string,
  sourceBaseline: number,
  targetCurrent: number,
  evaluateStatus: (percentDelta: number, targetValue: number) => BaselineMetricStatus,
): BaselineMetric {
  if (sourceBaseline === 0) {
    return {
      name,
      sourceBaseline,
      targetCurrent,
      percentDelta: null,
      status: 'unavailable',
    };
  }

  const percentDelta = ((targetCurrent - sourceBaseline) / sourceBaseline) * 100;

  return {
    name,
    sourceBaseline: Math.round(sourceBaseline * 100) / 100,
    targetCurrent: Math.round(targetCurrent * 100) / 100,
    percentDelta: Math.round(percentDelta * 100) / 100,
    status: evaluateStatus(percentDelta, targetCurrent),
  };
}
