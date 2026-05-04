import {
  StoredCommandLogEntry,
  StoredSlowLogEntry,
} from '../common/interfaces/storage-port.interface';

export interface LatencyEntry {
  timestamp: number;
  duration: number;
  command: string[];
  clientAddress: string;
  clientName: string;
}

const READ_COMMANDS = new Set(['GET', 'MGET']);
const WRITE_COMMANDS = new Set(['SET', 'HSET', 'HMSET', 'HSETNX']);

export function bucketEntry(command: readonly string[]): string | null {
  if (command.length === 0) return null;
  const head = command[0].toUpperCase();

  if (head === 'FT.SEARCH') {
    const index = command[1];
    return index ? `FT.SEARCH:${index}` : null;
  }
  if (READ_COMMANDS.has(head)) return 'read';
  if (WRITE_COMMANDS.has(head)) return 'write';
  return null;
}

export function projectToLatencyEntry(
  entry: StoredSlowLogEntry | StoredCommandLogEntry,
): LatencyEntry {
  return {
    timestamp: entry.timestamp,
    duration: entry.duration,
    command: entry.command,
    clientAddress: entry.clientAddress,
    clientName: entry.clientName,
  };
}
