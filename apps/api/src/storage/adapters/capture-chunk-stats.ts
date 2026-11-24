import type {
  CaptureChunkStats,
  CaptureChunkTotals,
} from '../../common/interfaces/storage-port.interface';

/** Folds per-node GROUP BY rows (node_id may be NULL) into overall + per-node totals. */
export function foldChunkStatRows(
  rows: Array<CaptureChunkTotals & { nodeId: string | null }>,
): CaptureChunkStats | null {
  if (rows.length === 0) return null;
  const stats: CaptureChunkStats = { lastTs: -Infinity, byteCount: 0, lineCount: 0, byNode: {} };
  for (const { nodeId, lastTs, byteCount, lineCount } of rows) {
    stats.lastTs = Math.max(stats.lastTs, lastTs);
    stats.byteCount += byteCount;
    stats.lineCount += lineCount;
    if (nodeId) stats.byNode[nodeId] = { lastTs, byteCount, lineCount };
  }
  return stats;
}
