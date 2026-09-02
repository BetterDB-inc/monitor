import { Logger } from '@nestjs/common';
import { StoragePort } from '../common/interfaces/storage-port.interface';

/**
 * One prune pass over every store that accumulates monitoring history, keyed
 * by a stable name for logging. Shared by the cloud tier-based sweep and the
 * self-hosted local sweep so the two never drift on which tables are covered.
 *
 * A store that fails to prune is reported as -1 and does not stop the sweep.
 */
export async function runRetentionSweep(
  storage: StoragePort,
  cutoff: number,
  logger: Logger,
): Promise<Record<string, number>> {
  const pruneOps: Array<{ name: string; fn: () => Promise<number> }> = [
    { name: 'slowlog', fn: () => storage.pruneOldSlowLogEntries(cutoff) },
    { name: 'commandlog', fn: () => storage.pruneOldCommandLogEntries(cutoff) },
    { name: 'client_snapshots', fn: () => storage.pruneOldClientSnapshots(cutoff) },
    { name: 'anomaly_events', fn: () => storage.pruneOldAnomalyEvents(cutoff) },
    { name: 'correlated_groups', fn: () => storage.pruneOldCorrelatedGroups(cutoff) },
    { name: 'key_patterns', fn: () => storage.pruneOldKeyPatternSnapshots(cutoff) },
    { name: 'acl_entries', fn: () => storage.pruneOldEntries(cutoff) },
    { name: 'webhook_deliveries', fn: () => storage.pruneOldDeliveries(cutoff) },
    { name: 'latency_snapshots', fn: () => storage.pruneOldLatencySnapshots(cutoff) },
    { name: 'latency_histograms', fn: () => storage.pruneOldLatencyHistograms(cutoff) },
    { name: 'memory_snapshots', fn: () => storage.pruneOldMemorySnapshots(cutoff) },
    { name: 'capture_chunks', fn: () => storage.pruneOldCaptureChunks(cutoff) },
    { name: 'capture_sessions', fn: () => storage.pruneOldCaptureSessions(cutoff) },
    { name: 'capture_triggers', fn: () => storage.pruneOldCaptureTriggers(cutoff) },
    { name: 'scheduled_captures', fn: () => storage.pruneOldScheduledCaptures(cutoff) },
    { name: 'ai_cache_samples', fn: () => storage.pruneOldAiCacheSamples(cutoff) },
    { name: 'otel_spans', fn: () => storage.pruneOldOtelSpans(cutoff) },
  ];

  const results: Record<string, number> = {};
  for (const op of pruneOps) {
    try {
      results[op.name] = await op.fn();
    } catch (err) {
      logger.error(`Failed to prune ${op.name}:`, err);
      results[op.name] = -1;
    }
  }
  return results;
}

export function totalPruned(results: Record<string, number>): number {
  return Object.values(results)
    .filter((v) => v > 0)
    .reduce((a, b) => a + b, 0);
}
