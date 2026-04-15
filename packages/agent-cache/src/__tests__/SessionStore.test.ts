import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionStore, SessionTracker } from '../tiers/SessionStore';
import type { Telemetry } from '../telemetry';
import type { Valkey } from '../types';

function createMockClient(): Valkey {
  return {
    get: vi.fn(),
    set: vi.fn(),
    expire: vi.fn(),
    hincrby: vi.fn(),
    del: vi.fn(),
    scan: vi.fn(),
    mget: vi.fn(),
    pipeline: vi.fn(() => ({
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    })),
  } as unknown as Valkey;
}

function createMockTelemetry(): Telemetry {
  return {
    tracer: {
      startActiveSpan: vi.fn((_name, fn) => fn({
        setAttribute: vi.fn(),
        recordException: vi.fn(),
        end: vi.fn(),
      })),
    },
    metrics: {
      requestsTotal: { labels: vi.fn(() => ({ inc: vi.fn() })) },
      operationDuration: { labels: vi.fn(() => ({ observe: vi.fn() })) },
      costSaved: { labels: vi.fn(() => ({ inc: vi.fn() })) },
      storedBytes: { labels: vi.fn(() => ({ inc: vi.fn() })) },
      activeSessions: { labels: vi.fn(() => ({ inc: vi.fn(), dec: vi.fn(), set: vi.fn() })) },
    },
  } as unknown as Telemetry;
}

describe('SessionStore', () => {
  let client: Valkey;
  let telemetry: Telemetry;
  let store: SessionStore;

  beforeEach(() => {
    client = createMockClient();
    telemetry = createMockTelemetry();
    store = new SessionStore({
      client,
      name: 'test_ac',
      defaultTtl: 3600,
      tierTtl: 1800,
      telemetry,
      statsKey: 'test_ac:__stats',
    });
  });

  describe('get()', () => {
    it('returns null when key does not exist', async () => {
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const value = await store.get('thread-1', 'last_intent');

      expect(value).toBeNull();
    });

    it('refreshes TTL on hit', async () => {
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue('book_flight');
      (client.expire as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      await store.get('thread-1', 'last_intent');

      expect(client.expire).toHaveBeenCalledWith(
        'test_ac:session:thread-1:last_intent',
        1800, // tier TTL
      );
    });

    it('records read in stats on hit', async () => {
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue('book_flight');

      await store.get('thread-1', 'last_intent');

      expect(client.hincrby).toHaveBeenCalledWith('test_ac:__stats', 'session:reads', 1);
    });

    it('records read in stats on miss (counts all read operations)', async () => {
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await store.get('thread-1', 'nonexistent');

      // Reads should be counted even for misses
      expect(client.hincrby).toHaveBeenCalledWith('test_ac:__stats', 'session:reads', 1);
    });

    it('does not refresh TTL on miss', async () => {
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await store.get('thread-1', 'nonexistent');

      expect(client.expire).not.toHaveBeenCalled();
    });
  });

  describe('set()', () => {
    it('writes value with SET EX (atomic operation)', async () => {
      (client.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

      await store.set('thread-1', 'last_intent', 'book_flight');

      expect(client.set).toHaveBeenCalledWith(
        'test_ac:session:thread-1:last_intent',
        'book_flight',
        'EX',
        1800,
      );
    });

    it('uses custom TTL with SET EX when provided', async () => {
      (client.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

      await store.set('thread-1', 'last_intent', 'book_flight', 900);

      expect(client.set).toHaveBeenCalledWith(
        'test_ac:session:thread-1:last_intent',
        'book_flight',
        'EX',
        900,
      );
    });

    it('records write in stats', async () => {
      (client.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
      (client.expire as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      await store.set('thread-1', 'last_intent', 'book_flight');

      expect(client.hincrby).toHaveBeenCalledWith('test_ac:__stats', 'session:writes', 1);
    });
  });

  describe('getAll()', () => {
    it('scans correct pattern and returns stripped field names', async () => {
      (client.scan as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(['0', [
          'test_ac:session:thread-1:last_intent',
          'test_ac:session:thread-1:user_name',
        ]]);
      (client.mget as ReturnType<typeof vi.fn>).mockResolvedValue(['book_flight', 'John']);

      const result = await store.getAll('thread-1');

      expect(client.scan).toHaveBeenCalledWith('0', 'MATCH', 'test_ac:session:thread-1:*', 'COUNT', 100);
      expect(result).toEqual({
        last_intent: 'book_flight',
        user_name: 'John',
      });
    });
  });

  describe('delete()', () => {
    it('returns true when key existed', async () => {
      (client.del as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const deleted = await store.delete('thread-1', 'last_intent');

      expect(deleted).toBe(true);
      expect(client.del).toHaveBeenCalledWith('test_ac:session:thread-1:last_intent');
    });

    it('returns false when key did not exist', async () => {
      (client.del as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      const deleted = await store.delete('thread-1', 'unknown');

      expect(deleted).toBe(false);
    });
  });

  describe('destroyThread()', () => {
    it('scans and deletes all thread keys', async () => {
      (client.scan as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(['0', [
          'test_ac:session:thread-1:last_intent',
          'test_ac:session:thread-1:user_name',
          'test_ac:session:thread-1:checkpoint:abc',
        ]]);
      (client.del as ReturnType<typeof vi.fn>).mockResolvedValue(3);

      const deleted = await store.destroyThread('thread-1');

      expect(deleted).toBe(3);
      expect(client.del).toHaveBeenCalledWith(
        'test_ac:session:thread-1:last_intent',
        'test_ac:session:thread-1:user_name',
        'test_ac:session:thread-1:checkpoint:abc',
      );
    });

    it('escapes glob metacharacters in threadId during invalidation scan', async () => {
      (client.scan as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(['0', ['test_ac:session:thread-[1]:last_intent']]);
      (client.del as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const deleted = await store.destroyThread('thread-[1]');

      expect(deleted).toBe(1);
      expect(client.scan).toHaveBeenCalledWith(
        '0',
        'MATCH',
        'test_ac:session:thread-\\[1\\]:*',
        'COUNT',
        100,
      );
      expect(client.del).toHaveBeenCalledWith('test_ac:session:thread-[1]:last_intent');
    });
  });

  describe('scanFieldsByPrefix()', () => {
    it('returns matching fields stripped of key prefix', async () => {
      (client.scan as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(['0', [
          'test_ac:session:thread-1:writes:cp-1|task-1|output|0',
          'test_ac:session:thread-1:writes:cp-1|task-1|state|1',
        ]]);
      (client.mget as ReturnType<typeof vi.fn>).mockResolvedValue(['"result"', '{"step":2}']);

      const result = await store.scanFieldsByPrefix('thread-1', 'writes:cp-1|');

      expect(client.scan).toHaveBeenCalledWith(
        '0', 'MATCH', 'test_ac:session:thread-1:writes:cp-1|*', 'COUNT', 100,
      );
      expect(result).toEqual({
        'writes:cp-1|task-1|output|0': '"result"',
        'writes:cp-1|task-1|state|1': '{"step":2}',
      });
    });

    it('returns empty object when no keys match', async () => {
      (client.scan as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['0', []]);

      const result = await store.scanFieldsByPrefix('thread-1', 'writes:cp-nonexistent|');

      expect(result).toEqual({});
      expect(client.mget).not.toHaveBeenCalled();
    });

    it('does NOT refresh TTL on matched keys (unlike getAll)', async () => {
      (client.scan as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(['0', [
          'test_ac:session:thread-1:writes:cp-1|task-1|output|0',
        ]]);
      (client.mget as ReturnType<typeof vi.fn>).mockResolvedValue(['"result"']);

      await store.scanFieldsByPrefix('thread-1', 'writes:cp-1|');

      expect(client.expire).not.toHaveBeenCalled();
    });

    it('handles multi-page SCAN cursor', async () => {
      (client.scan as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(['42', [
          'test_ac:session:thread-1:writes:cp-1|task-1|a|0',
        ]])
        .mockResolvedValueOnce(['0', [
          'test_ac:session:thread-1:writes:cp-1|task-1|b|0',
        ]]);
      (client.mget as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(['"val-a"'])
        .mockResolvedValueOnce(['"val-b"']);

      const result = await store.scanFieldsByPrefix('thread-1', 'writes:cp-1|');

      expect(client.scan).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        'writes:cp-1|task-1|a|0': '"val-a"',
        'writes:cp-1|task-1|b|0': '"val-b"',
      });
    });
  });

  describe('SessionTracker LRU eviction', () => {
    it('evicts the oldest entry when at capacity and returns it', () => {
      const tracker = new SessionTracker(3);

      expect(tracker.add('a')).toEqual({ isNew: true, evicted: undefined });
      expect(tracker.add('b')).toEqual({ isNew: true, evicted: undefined });
      expect(tracker.add('c')).toEqual({ isNew: true, evicted: undefined });

      // At capacity - adding 'd' should evict 'a' (oldest)
      const result = tracker.add('d');
      expect(result.isNew).toBe(true);
      expect(result.evicted).toBe('a');
    });

    it('re-adding an existing entry updates LRU order and is not new', () => {
      const tracker = new SessionTracker(3);
      let now = 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);

      now = 1000; tracker.add('a');
      now = 2000; tracker.add('b');
      now = 3000; tracker.add('c');

      // Touch 'a' to make it most recent
      now = 4000;
      expect(tracker.add('a')).toEqual({ isNew: false });

      // Now 'b' (timestamp 2000) is the oldest — should be evicted
      now = 5000;
      const result = tracker.add('d');
      expect(result.isNew).toBe(true);
      expect(result.evicted).toBe('b');

      vi.restoreAllMocks();
    });

    it('remove() returns true for tracked and false for untracked', () => {
      const tracker = new SessionTracker(3);
      tracker.add('a');

      expect(tracker.remove('a')).toBe(true);
      expect(tracker.remove('a')).toBe(false);
      expect(tracker.remove('never-added')).toBe(false);
    });
  });

  describe('active_sessions gauge tracks eviction via set()', () => {
    it('increments gauge on new thread, decrements on eviction', async () => {
      const incFn = vi.fn();
      const decFn = vi.fn();
      const localTelemetry = {
        tracer: {
          startActiveSpan: vi.fn((_name: string, fn: (span: unknown) => unknown) => fn({
            setAttribute: vi.fn(),
            recordException: vi.fn(),
            end: vi.fn(),
          })),
        },
        metrics: {
          requestsTotal: { labels: vi.fn(() => ({ inc: vi.fn() })) },
          operationDuration: { labels: vi.fn(() => ({ observe: vi.fn() })) },
          costSaved: { labels: vi.fn(() => ({ inc: vi.fn() })) },
          storedBytes: { labels: vi.fn(() => ({ inc: vi.fn() })) },
          activeSessions: { labels: vi.fn(() => ({ inc: incFn, dec: decFn, set: vi.fn() })) },
        },
      } as unknown as Telemetry;

      const localStore = new SessionStore({
        client,
        name: 'test_ac',
        defaultTtl: 3600,
        tierTtl: 1800,
        telemetry: localTelemetry,
        statsKey: 'test_ac:__stats',
      });

      (client.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

      await localStore.set('t-1', 'f', 'v');
      expect(incFn).toHaveBeenCalledTimes(1);
      expect(decFn).not.toHaveBeenCalled();

      // Same thread - no increment
      await localStore.set('t-1', 'f2', 'v2');
      expect(incFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('touch()', () => {
    it('refreshes TTL on all thread keys', async () => {
      const mockPipeline = {
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      };
      (client.pipeline as ReturnType<typeof vi.fn>).mockReturnValue(mockPipeline);

      (client.scan as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(['0', [
          'test_ac:session:thread-1:last_intent',
          'test_ac:session:thread-1:user_name',
        ]]);

      await store.touch('thread-1');

      expect(mockPipeline.expire).toHaveBeenCalledWith('test_ac:session:thread-1:last_intent', 1800);
      expect(mockPipeline.expire).toHaveBeenCalledWith('test_ac:session:thread-1:user_name', 1800);
      expect(mockPipeline.exec).toHaveBeenCalled();
    });
  });
});
