import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import type {
  StoragePort,
  StoredCommandLogEntry,
} from '../../../common/interfaces/storage-port.interface';

/**
 * The `command` filter must match the command VERB only (case-insensitive
 * substring), never keys or arguments — a `GET user:scan:results` row must not
 * satisfy `command: 'SCAN'`. The scan-skew analysis relies on this to keep its
 * bounded window on SCAN-family entries (valkey#3955).
 */
describe.each([
  ['MemoryAdapter', () => new MemoryAdapter()],
  ['SqliteAdapter', () => new SqliteAdapter({ filepath: ':memory:' })],
])('Command-log command filter (%s)', (_name, makeAdapter) => {
  let storage: StoragePort;
  const CONN = 'conn-a';

  beforeEach(async () => {
    storage = makeAdapter() as unknown as StoragePort;
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  const entry = (id: number, command: string[]): StoredCommandLogEntry => ({
    id,
    timestamp: 1000 + id,
    duration: 1_000_000,
    command,
    clientAddress: '127.0.0.1:6379',
    clientName: 'c',
    type: 'large-reply',
    capturedAt: (1000 + id) * 1000,
    sourceHost: 'h',
    sourcePort: 6379,
  });

  it('matches the verb only, not keys or arguments', async () => {
    await storage.saveCommandLogEntries(
      [
        entry(1, ['SSCAN', 'myset', '0', 'COUNT', '1024']),
        entry(2, ['hscan', 'myhash', '0']),
        entry(3, ['GET', 'user:scan:results']),
        entry(4, ['HGETALL', 'session:SCAN:cache']),
      ],
      CONN,
    );

    const rows = await storage.getCommandLogEntries({ connectionId: CONN, command: 'SCAN' });
    const verbs = rows
      .map((r) => {
        return r.command[0].toUpperCase();
      })
      .sort();
    expect(verbs).toEqual(['HSCAN', 'SSCAN']);
  });
});
