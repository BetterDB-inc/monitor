import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlmCache } from '../tiers/LlmCache';
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
      activeSessions: { labels: vi.fn(() => ({ inc: vi.fn(), dec: vi.fn() })) },
    },
  } as unknown as Telemetry;
}

describe('LlmCache', () => {
  let client: Valkey;
  let telemetry: Telemetry;
  let cache: LlmCache;

  beforeEach(() => {
    client = createMockClient();
    telemetry = createMockTelemetry();
    cache = new LlmCache({
      client,
      name: 'test_ac',
      defaultTtl: undefined,
      tierTtl: 3600,
      costTable: {
        'gpt-4o': { inputPer1k: 0.0025, outputPer1k: 0.01 },
      },
      telemetry,
      statsKey: 'test_ac:__stats',
    });
  });

  describe('check()', () => {
    it('returns miss when key does not exist', async () => {
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await cache.check({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(result.hit).toBe(false);
      expect(result.tier).toBe('llm');
      expect(result.response).toBeUndefined();
    });

    it('returns hit with parsed response when key exists', async () => {
      const stored = JSON.stringify({
        response: 'Hello there!',
        model: 'gpt-4o',
        storedAt: Date.now(),
      });
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue(stored);

      const result = await cache.check({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(result.hit).toBe(true);
      expect(result.tier).toBe('llm');
      expect(result.response).toBe('Hello there!');
      expect(result.key).toContain('test_ac:llm:');
    });

    it('records hit in stats', async () => {
      const stored = JSON.stringify({
        response: 'Hello there!',
        model: 'gpt-4o',
        storedAt: Date.now(),
      });
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue(stored);

      await cache.check({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(client.hincrby).toHaveBeenCalledWith('test_ac:__stats', 'llm:hits', 1);
    });

    it('records miss in stats', async () => {
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await cache.check({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(client.hincrby).toHaveBeenCalledWith('test_ac:__stats', 'llm:misses', 1);
    });
  });

  describe('store()', () => {
    it('calls SET with correct key format and JSON value', async () => {
      (client.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
      (client.expire as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      await cache.store(
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
        'Hello there!',
      );

      expect(client.set).toHaveBeenCalled();
      const [key, value] = (client.set as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(key).toContain('test_ac:llm:');
      const parsed = JSON.parse(value);
      expect(parsed.response).toBe('Hello there!');
      expect(parsed.model).toBe('gpt-4o');
    });

    it('uses SET with EX when TTL provided (atomic operation)', async () => {
      (client.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

      await cache.store(
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
        'Hello there!',
        { ttl: 1800 },
      );

      expect(client.set).toHaveBeenCalledWith(
        expect.stringContaining('test_ac:llm:'),
        expect.any(String),
        'EX',
        1800,
      );
    });

    it('uses tier TTL with SET EX when no per-call TTL', async () => {
      (client.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

      await cache.store(
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
        'Hello there!',
      );

      expect(client.set).toHaveBeenCalledWith(
        expect.stringContaining('test_ac:llm:'),
        expect.any(String),
        'EX',
        3600,
      );
    });

    it('calls SET without EX when no TTL at any level', async () => {
      const noTtlCache = new LlmCache({
        client,
        name: 'test_ac',
        defaultTtl: undefined,
        tierTtl: undefined,
        costTable: undefined,
        telemetry,
        statsKey: 'test_ac:__stats',
      });

      (client.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

      await noTtlCache.store(
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
        'Hello there!',
      );

      // SET called without EX argument
      expect(client.set).toHaveBeenCalledWith(
        expect.stringContaining('test_ac:llm:'),
        expect.any(String),
      );
      // Verify only 2 arguments (no EX)
      expect((client.set as ReturnType<typeof vi.fn>).mock.calls[0].length).toBe(2);
    });

    it('calculates and stores cost when costTable and tokens provided', async () => {
      (client.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
      (client.expire as ReturnType<typeof vi.fn>).mockResolvedValue(1);
      (client.hincrby as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      await cache.store(
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
        'Hello there!',
        { tokens: { input: 10, output: 20 } },
      );

      // Verify cost_saved_cents was incremented
      expect(client.hincrby).toHaveBeenCalledWith(
        'test_ac:__stats',
        'cost_saved_cents',
        expect.any(Number),
      );
    });
  });

  describe('invalidateByModel()', () => {
    it('deletes only matching model entries', async () => {
      const entry1 = JSON.stringify({ response: 'A', model: 'gpt-4o', storedAt: Date.now() });
      const entry2 = JSON.stringify({ response: 'B', model: 'gpt-3.5', storedAt: Date.now() });

      (client.scan as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(['0', ['test_ac:llm:abc', 'test_ac:llm:def']]);

      (client.get as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(entry1)
        .mockResolvedValueOnce(entry2);

      (client.del as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const deleted = await cache.invalidateByModel('gpt-4o');

      expect(deleted).toBe(1);
      expect(client.del).toHaveBeenCalledWith('test_ac:llm:abc');
      expect(client.del).not.toHaveBeenCalledWith('test_ac:llm:def');
    });
  });
});
