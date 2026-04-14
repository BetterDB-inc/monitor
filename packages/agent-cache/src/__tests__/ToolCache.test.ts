import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolCache } from '../tiers/ToolCache';
import type { Telemetry } from '../telemetry';
import type { Valkey } from '../types';

function createMockClient(): Valkey {
  return {
    get: vi.fn(),
    set: vi.fn(),
    expire: vi.fn(),
    hincrby: vi.fn(),
    hset: vi.fn(),
    hgetall: vi.fn(),
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

describe('ToolCache', () => {
  let client: Valkey;
  let telemetry: Telemetry;
  let cache: ToolCache;

  beforeEach(() => {
    client = createMockClient();
    telemetry = createMockTelemetry();
    cache = new ToolCache({
      client,
      name: 'test_ac',
      defaultTtl: 600,
      tierTtl: 300,
      telemetry,
      statsKey: 'test_ac:__stats',
    });
  });

  describe('check()', () => {
    it('returns miss when key does not exist', async () => {
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await cache.check('get_weather', { city: 'Sofia' });

      expect(result.hit).toBe(false);
      expect(result.tier).toBe('tool');
      expect(result.toolName).toBe('get_weather');
      expect(result.response).toBeUndefined();
    });

    it('returns hit with toolName in result', async () => {
      const stored = JSON.stringify({
        response: '{"temp": 20}',
        toolName: 'get_weather',
        args: { city: 'Sofia' },
        storedAt: Date.now(),
      });
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue(stored);

      const result = await cache.check('get_weather', { city: 'Sofia' });

      expect(result.hit).toBe(true);
      expect(result.tier).toBe('tool');
      expect(result.toolName).toBe('get_weather');
      expect(result.response).toBe('{"temp": 20}');
    });

    it('records tier-level and per-tool hit', async () => {
      const stored = JSON.stringify({
        response: '{}',
        toolName: 'get_weather',
        args: {},
        storedAt: Date.now(),
      });
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue(stored);

      await cache.check('get_weather', {});

      expect(client.hincrby).toHaveBeenCalledWith('test_ac:__stats', 'tool:hits', 1);
      expect(client.hincrby).toHaveBeenCalledWith('test_ac:__stats', 'tool:get_weather:hits', 1);
    });

    it('records tier-level and per-tool miss', async () => {
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await cache.check('get_weather', {});

      expect(client.hincrby).toHaveBeenCalledWith('test_ac:__stats', 'tool:misses', 1);
      expect(client.hincrby).toHaveBeenCalledWith('test_ac:__stats', 'tool:get_weather:misses', 1);
    });
  });

  describe('store()', () => {
    it('uses per-tool policy TTL when set', async () => {
      (client.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
      (client.expire as ReturnType<typeof vi.fn>).mockResolvedValue(1);
      (client.hset as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      await cache.setPolicy('get_weather', { ttl: 120 });

      await cache.store('get_weather', { city: 'Sofia' }, '{"temp": 20}');

      expect(client.expire).toHaveBeenCalled();
      const [, ttl] = (client.expire as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(ttl).toBe(120);
    });

    it('falls back through TTL hierarchy: per-call -> policy -> tier -> default', async () => {
      (client.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
      (client.expire as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      // No policy, no per-call TTL - should use tier TTL (300)
      await cache.store('search', {}, 'result');

      const [, ttl] = (client.expire as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(ttl).toBe(300);
    });

    it('records cost when provided', async () => {
      (client.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
      (client.expire as ReturnType<typeof vi.fn>).mockResolvedValue(1);
      (client.hincrby as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      await cache.store('expensive_api', {}, 'result', { cost: 0.05 });

      expect(client.hincrby).toHaveBeenCalledWith('test_ac:__stats', 'cost_saved_cents', 5);
      expect(client.hincrby).toHaveBeenCalledWith('test_ac:__stats', 'tool:expensive_api:cost_saved_cents', 5);
    });
  });

  describe('setPolicy()', () => {
    it('persists to Valkey hash', async () => {
      (client.hset as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      await cache.setPolicy('get_weather', { ttl: 120 });

      expect(client.hset).toHaveBeenCalledWith(
        'test_ac:__tool_policies',
        'get_weather',
        JSON.stringify({ ttl: 120 }),
      );
    });
  });

  describe('invalidateByTool()', () => {
    it('scans and deletes correct pattern', async () => {
      (client.scan as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(['0', ['test_ac:tool:get_weather:abc', 'test_ac:tool:get_weather:def']]);
      (client.del as ReturnType<typeof vi.fn>).mockResolvedValue(2);

      const deleted = await cache.invalidateByTool('get_weather');

      expect(deleted).toBe(2);
      expect(client.scan).toHaveBeenCalledWith('0', 'MATCH', 'test_ac:tool:get_weather:*', 'COUNT', 100);
      expect(client.del).toHaveBeenCalledWith('test_ac:tool:get_weather:abc', 'test_ac:tool:get_weather:def');
    });
  });

  describe('invalidate()', () => {
    it('deletes specific key', async () => {
      (client.del as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const deleted = await cache.invalidate('get_weather', { city: 'Sofia' });

      expect(deleted).toBe(true);
      expect(client.del).toHaveBeenCalledWith(expect.stringContaining('test_ac:tool:get_weather:'));
    });

    it('returns false when key did not exist', async () => {
      (client.del as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      const deleted = await cache.invalidate('get_weather', { city: 'Unknown' });

      expect(deleted).toBe(false);
    });
  });

  describe('loadPolicies()', () => {
    it('loads policies from Valkey', async () => {
      (client.hgetall as ReturnType<typeof vi.fn>).mockResolvedValue({
        get_weather: JSON.stringify({ ttl: 120 }),
        search: JSON.stringify({ ttl: 60 }),
      });

      await cache.loadPolicies();

      expect(cache.getPolicy('get_weather')).toEqual({ ttl: 120 });
      expect(cache.getPolicy('search')).toEqual({ ttl: 60 });
    });
  });
});
