import type { CommandLogType } from '../interfaces/database-port.interface';

export const SLOWLOG_CAPTURE = 'slowlog';

export function commandLogCapture(type: CommandLogType): string {
  return `commandlog-${type}`;
}

export interface LogEntryRef {
  id: number;
  timestamp: number;
}

const NO_LOST_ENTRIES: ReadonlyMap<string, number> = new Map();

export class LogGapTracker {
  private readonly newestTimestamps = new Map<string, Map<string, number | null>>();
  private readonly lost = new Map<string, Map<string, number>>();

  idsRestarted(
    connectionId: string,
    log: string,
    entries: readonly LogEntryRef[],
    lastSeenId: number | null,
  ): boolean {
    if (lastSeenId === null || entries.length === 0) {
      return false;
    }
    if (entries.every((entry) => entry.id < lastSeenId)) {
      return true;
    }
    const newestTimestamp = this.newestTimestamps.get(connectionId)?.get(log) ?? null;
    return (
      newestTimestamp !== null &&
      entries.some((entry) => entry.id <= lastSeenId && entry.timestamp > newestTimestamp)
    );
  }

  completePoll(
    connectionId: string,
    log: string,
    entries: readonly LogEntryRef[],
    lastSeenId: number | null,
  ): number {
    const newestTimestamps = this.logsOf(this.newestTimestamps, connectionId);
    const lost = this.logsOf(this.lost, connectionId);
    const polledBefore = newestTimestamps.has(log);

    let missed = 0;
    if (polledBefore && lastSeenId !== null && entries.length > 0) {
      const oldestId = Math.min(...entries.map((entry) => entry.id));
      missed = Math.max(0, oldestId - lastSeenId - 1);
    }
    lost.set(log, (lost.get(log) ?? 0) + missed);

    const previous = lastSeenId === null ? null : (newestTimestamps.get(log) ?? null);
    newestTimestamps.set(
      log,
      entries.reduce<number | null>(
        (newest, entry) => (newest === null || entry.timestamp > newest ? entry.timestamp : newest),
        previous,
      ),
    );
    return missed;
  }

  lostEntries(connectionId: string): ReadonlyMap<string, number> {
    return this.lost.get(connectionId) ?? NO_LOST_ENTRIES;
  }

  sourceChanged(connectionId: string): void {
    this.newestTimestamps.delete(connectionId);
  }

  forget(connectionId: string): void {
    this.newestTimestamps.delete(connectionId);
    this.lost.delete(connectionId);
  }

  private logsOf<V>(
    byConnection: Map<string, Map<string, V>>,
    connectionId: string,
  ): Map<string, V> {
    let logs = byConnection.get(connectionId);
    if (!logs) {
      logs = new Map();
      byConnection.set(connectionId, logs);
    }
    return logs;
  }
}
