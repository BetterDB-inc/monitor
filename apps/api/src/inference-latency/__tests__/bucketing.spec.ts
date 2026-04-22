import { bucketEntry, projectToLatencyEntry } from '../bucketing';
import {
  StoredCommandLogEntry,
  StoredSlowLogEntry,
} from '../../common/interfaces/storage-port.interface';

describe('bucketEntry', () => {
  const cases: Array<{ command: string[]; expected: string | null; label: string }> = [
    { command: ['FT.SEARCH', 'idx_cache', '*'], expected: 'FT.SEARCH:idx_cache', label: 'FT.SEARCH → per-index' },
    { command: ['ft.search', 'idx_cache', '*'], expected: 'FT.SEARCH:idx_cache', label: 'lowercase FT.SEARCH normalised' },
    { command: ['GET', 'session:abc'], expected: 'read', label: 'GET → read' },
    { command: ['MGET', 'k1', 'k2'], expected: 'read', label: 'MGET → read' },
    { command: ['SET', 'k', 'v'], expected: 'write', label: 'SET → write' },
    { command: ['HSET', 'h', 'f', 'v'], expected: 'write', label: 'HSET → write' },
    { command: ['HMSET', 'h', 'f1', 'v1'], expected: 'write', label: 'HMSET → write' },
    { command: ['HSETNX', 'h', 'f', 'v'], expected: 'write', label: 'HSETNX → write' },
    { command: ['FT.CREATE', 'idx', 'SCHEMA', 'v', 'VECTOR'], expected: null, label: 'FT.CREATE dropped' },
    { command: ['SUBSCRIBE', 'ch'], expected: null, label: 'SUBSCRIBE dropped' },
    { command: [], expected: null, label: 'empty command dropped' },
    { command: ['FT.SEARCH'], expected: null, label: 'FT.SEARCH without index dropped' },
  ];

  it.each(cases)('buckets $label', ({ command, expected }) => {
    expect(bucketEntry(command)).toBe(expected);
  });
});

describe('projectToLatencyEntry', () => {
  const baseSlow: StoredSlowLogEntry = {
    id: 1,
    timestamp: 1_700_000_000,
    duration: 12_345,
    command: ['GET', 'k'],
    clientAddress: '127.0.0.1:1234',
    clientName: 'worker',
    capturedAt: 1_700_000_001_000,
    sourceHost: 'h',
    sourcePort: 6379,
    connectionId: 'conn-1',
  };

  const baseCmd: StoredCommandLogEntry = {
    ...baseSlow,
    type: 'slow',
  };

  it('projects a slowlog entry to the shared shape', () => {
    expect(projectToLatencyEntry(baseSlow)).toEqual({
      timestamp: 1_700_000_000,
      duration: 12_345,
      command: ['GET', 'k'],
      clientAddress: '127.0.0.1:1234',
      clientName: 'worker',
    });
  });

  it('projects a commandlog entry to the same shape (no type field)', () => {
    const projected = projectToLatencyEntry(baseCmd);
    expect(projected).toEqual(projectToLatencyEntry(baseSlow));
    expect(projected).not.toHaveProperty('type');
  });
});
