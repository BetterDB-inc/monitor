import {
  SlowLogQueryOptions,
  StoredSlowLogEntry,
} from '../../../common/interfaces/storage-port.interface';

export class SlowLogMemoryRepository {
  private slowLogEntries: StoredSlowLogEntry[] = [];

  async saveSlowLogEntries(entries: StoredSlowLogEntry[], connectionId: string): Promise<number> {
    let savedCount = 0;
    for (const entry of entries) {
      // Check for duplicates based on unique constraint (including connectionId)
      const exists = this.slowLogEntries.some(
        (e) =>
          e.id === entry.id &&
          e.sourceHost === entry.sourceHost &&
          e.sourcePort === entry.sourcePort &&
          e.connectionId === connectionId,
      );
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

    return filtered
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 100));
  }

  async getLatestSlowLogId(connectionId?: string): Promise<number | null> {
    let entries = this.slowLogEntries;
    if (connectionId) {
      entries = entries.filter((e) => e.connectionId === connectionId);
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
