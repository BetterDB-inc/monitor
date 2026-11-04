import {
  LogSource,
  SlowLogQueryOptions,
  StoredSlowLogEntry,
} from '../../../common/interfaces/storage-port.interface';

/** Same rule as the SQL adapters: match the run id, and the address only when it is unknown. */
export function matchesLogSource(
  entry: { sourceHost: string; sourcePort: number; sourceRunId?: string },
  source: LogSource,
): boolean {
  if ((entry.sourceRunId ?? '') !== (source.runId ?? '')) return false;
  return source.runId ? true : entry.sourceHost === source.host && entry.sourcePort === source.port;
}

/**
 * Same keys as the SQL unique constraints: entries with a run id are one entry
 * per (id, run id), whatever address they were read through; entries without
 * one are keyed by address.
 */
export function isSameLogEntry(
  a: { id: number; sourceHost: string; sourcePort: number; sourceRunId?: string; connectionId?: string },
  b: { id: number; sourceHost: string; sourcePort: number; sourceRunId?: string },
  connectionId: string,
): boolean {
  if (a.id !== b.id || a.connectionId !== connectionId) return false;
  if ((a.sourceRunId ?? '') !== (b.sourceRunId ?? '')) return false;
  return a.sourceRunId ? true : a.sourceHost === b.sourceHost && a.sourcePort === b.sourcePort;
}

export class SlowLogMemoryRepository {
  private slowLogEntries: StoredSlowLogEntry[] = [];

  async saveSlowLogEntries(entries: StoredSlowLogEntry[], connectionId: string): Promise<number> {
    let savedCount = 0;
    for (const entry of entries) {
      const exists = this.slowLogEntries.some((e) => isSameLogEntry(e, entry, connectionId));
      if (!exists) {
        this.slowLogEntries.push({ ...entry, connectionId });
        savedCount++;
      }
    }
    return savedCount;
  }

  async getSlowLogEntries(options: SlowLogQueryOptions = {}): Promise<StoredSlowLogEntry[]> {
    let filtered = [...this.slowLogEntries];

    if (options.connectionId) {
      filtered = filtered.filter((e) => e.connectionId === options.connectionId);
    }
    if (options.startTime) {
      filtered = filtered.filter((e) => e.timestamp >= options.startTime!);
    }
    if (options.endTime) {
      filtered = filtered.filter((e) => e.timestamp <= options.endTime!);
    }
    if (options.command) {
      const cmd = options.command.toLowerCase();
      // command is an array, check if the first element (command name) matches
      filtered = filtered.filter((e) => e.command[0]?.toLowerCase().includes(cmd));
    }
    if (options.clientName) {
      const name = options.clientName.toLowerCase();
      filtered = filtered.filter((e) => e.clientName.toLowerCase().includes(name));
    }
    if (options.minDuration) {
      filtered = filtered.filter((e) => e.duration >= options.minDuration!);
    }

    const compare =
      options.sortBy === 'magnitude'
        ? (a: StoredSlowLogEntry, b: StoredSlowLogEntry) => b.duration - a.duration || b.timestamp - a.timestamp
        : (a: StoredSlowLogEntry, b: StoredSlowLogEntry) => b.timestamp - a.timestamp;

    return filtered
      .sort(compare)
      .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 100));
  }

  async getLatestSlowLogId(connectionId?: string, source?: LogSource): Promise<number | null> {
    let entries = this.slowLogEntries;
    if (connectionId) {
      entries = entries.filter((e) => e.connectionId === connectionId);
    }
    if (source) {
      entries = entries.filter((e) => matchesLogSource(e, source));
    }
    if (entries.length === 0) return null;
    return Math.max(...entries.map((e) => e.id));
  }

  async pruneOldSlowLogEntries(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    const before = this.slowLogEntries.length;
    if (connectionId) {
      this.slowLogEntries = this.slowLogEntries.filter(
        (e) => e.capturedAt >= cutoffTimestamp || e.connectionId !== connectionId,
      );
    } else {
      this.slowLogEntries = this.slowLogEntries.filter((e) => e.capturedAt >= cutoffTimestamp);
    }
    return before - this.slowLogEntries.length;
  }
}
