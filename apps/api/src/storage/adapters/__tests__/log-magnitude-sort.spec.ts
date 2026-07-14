import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import type {
  StoragePort,
  StoredSlowLogEntry,
  StoredCommandLogEntry,
} from '../../../common/interfaces/storage-port.interface';

/**
 * Covers the `sortBy: 'magnitude'` option (valkey-io/valkey#2090-adjacent
 * feature request #3895): return SLOWLOG / COMMANDLOG entries ranked by the
 * worst offenders (top-N by duration) rather than only by recency.
 */
describe.each([
  ['MemoryAdapter', () => new MemoryAdapter()],
  ['SqliteAdapter', () => new SqliteAdapter({ filepath: ':memory:' })],
])('Log magnitude sort (%s)', (_name, makeAdapter) => {
  let storage: StoragePort;
  const CONN = 'conn-a';

  beforeEach(async () => {
    storage = makeAdapter() as unknown as StoragePort;
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  const slow = (id: number, timestamp: number, duration: number): StoredSlowLogEntry => ({
    id,
    timestamp,
    duration,
    command: ['GET', `key${id}`],
    clientAddress: '127.0.0.1:6379',
    clientName: 'c',
    capturedAt: timestamp * 1000,
    sourceHost: 'h',
    sourcePort: 6379,
  });

  const cmd = (
    id: number,
    timestamp: number,
    duration: number,
    type: StoredCommandLogEntry['type'],
  ): StoredCommandLogEntry => ({
    id,
    timestamp,
    duration,
    command: ['GET', `key${id}`],
    clientAddress: '127.0.0.1:6379',
    clientName: 'c',
    type,
    capturedAt: timestamp * 1000,
    sourceHost: 'h',
    sourcePort: 6379,
  });

  describe('slow log', () => {
    // Recency order (by timestamp desc) is deliberately the REVERSE of magnitude
    // order, so the two sorts can't be confused.
    beforeEach(async () => {
      await storage.saveSlowLogEntries(
        [
          slow(1, 3000, 100), // newest, smallest
          slow(2, 2000, 900), // worst offender
          slow(3, 1000, 500),
        ],
        CONN,
      );
    });

    it("defaults to recency (newest first) when sortBy is omitted", async () => {
      const rows = await storage.getSlowLogEntries({ connectionId: CONN });
      expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
    });

    it("orders by duration desc for sortBy 'magnitude'", async () => {
      const rows = await storage.getSlowLogEntries({ connectionId: CONN, sortBy: 'magnitude' });
      expect(rows.map((r) => r.id)).toEqual([2, 3, 1]);
      expect(rows.map((r) => r.duration)).toEqual([900, 500, 100]);
    });

    it('returns the top-N worst offenders when magnitude sort is combined with limit', async () => {
      const rows = await storage.getSlowLogEntries({ connectionId: CONN, sortBy: 'magnitude', limit: 2 });
      expect(rows.map((r) => r.id)).toEqual([2, 3]);
    });
  });

  describe('command log', () => {
    beforeEach(async () => {
      await storage.saveCommandLogEntries(
        [
          cmd(1, 3000, 10, 'large-reply'), // newest, smallest
          cmd(2, 2000, 5000, 'large-reply'), // worst by size
          cmd(3, 1000, 1200, 'large-reply'),
          cmd(4, 2500, 999999, 'slow'), // different type, should be filtered out
        ],
        CONN,
      );
    });

    it("defaults to recency (newest first)", async () => {
      const rows = await storage.getCommandLogEntries({ connectionId: CONN, type: 'large-reply' });
      expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
    });

    it("ranks worst offenders first for sortBy 'magnitude', respecting the type filter and limit", async () => {
      const rows = await storage.getCommandLogEntries({
        connectionId: CONN,
        type: 'large-reply',
        sortBy: 'magnitude',
        limit: 2,
      });
      expect(rows.map((r) => r.id)).toEqual([2, 3]);
      expect(rows.every((r) => r.type === 'large-reply')).toBe(true);
    });
  });
});
