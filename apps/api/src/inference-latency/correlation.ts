import { VectorIndexSnapshot } from '@betterdb/shared';
import { LatencyEntry } from './bucketing';

export interface IndexingEvent {
  kind: 'latency_degraded_during_indexing';
  bucket: string;
  since: number;
}

export interface AnnotateIndexingEventsParams {
  bucketKey: string;
  entries: readonly LatencyEntry[];
  snapshots: readonly VectorIndexSnapshot[];
  windowStartMs: number;
  windowEndMs: number;
}

const TAIL_FRACTION = 0.1;
const FT_SEARCH_BUCKET_PREFIX = 'FT.SEARCH:';

export function annotateIndexingEvents(params: AnnotateIndexingEventsParams): IndexingEvent[] {
  const { bucketKey, entries, snapshots, windowStartMs, windowEndMs } = params;

  if (!bucketKey.startsWith(FT_SEARCH_BUCKET_PREFIX)) return [];
  if (entries.length === 0) return [];

  const indexName = bucketKey.slice(FT_SEARCH_BUCKET_PREFIX.length);
  const relevantSnapshots = snapshots
    .filter(
      (s) =>
        s.indexName === indexName &&
        s.timestamp >= windowStartMs &&
        s.timestamp <= windowEndMs,
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  if (relevantSnapshots.length === 0) return [];

  const threshold = tailThreshold(entries);
  const tail = entries.filter((e) => e.duration >= threshold);

  const qualifyingSnapshotTimestamps: number[] = [];
  for (const e of tail) {
    const nearest = nearestSnapshotAtOrBefore(relevantSnapshots, e.timestamp);
    if (nearest && nearest.percentIndexed < 100) {
      qualifyingSnapshotTimestamps.push(nearest.timestamp);
    }
  }

  if (qualifyingSnapshotTimestamps.length === 0) return [];

  return [
    {
      kind: 'latency_degraded_during_indexing',
      bucket: bucketKey,
      since: Math.min(...qualifyingSnapshotTimestamps),
    },
  ];
}

function tailThreshold(entries: readonly LatencyEntry[]): number {
  const durations = entries.map((e) => e.duration).sort((a, b) => a - b);
  const cutoffIndex = Math.floor(durations.length * (1 - TAIL_FRACTION));
  return durations[Math.min(cutoffIndex, durations.length - 1)];
}

function nearestSnapshotAtOrBefore(
  sortedAsc: readonly VectorIndexSnapshot[],
  timestamp: number,
): VectorIndexSnapshot | null {
  let match: VectorIndexSnapshot | null = null;
  for (const s of sortedAsc) {
    if (s.timestamp <= timestamp) match = s;
    else break;
  }
  return match;
}
