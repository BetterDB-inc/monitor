import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolCache } from '../tiers/ToolCache';
import type { Telemetry } from '../telemetry';
import type { Valkey } from '../types';

function createMockClient(): Valkey {
  const hincrbyCalls: Array<[string, string, number]> = [];
  return {
    get: vi.fn(),
    set: vi.fn(),
    expire: vi.fn(),
    hincrby: vi.fn(),
    hset: vi.fn(),
    hgetall: vi.fn(),
    del: vi.fn(),
    scan: vi.fn(),
    pipeline: vi.fn(() => ({
      hincrby: vi.fn(function(this: unknown, key: string, field: string, val: number) {
        hincrbyCalls.push([key, field, val]);
        return this;
      }),
      exec: vi.fn().mockResolvedValue([]),
    })),
    _hincrbyCalls: hincrbyCalls,
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

    it('records tier-level and per-tool hit via pipeline', async () => {
      const stored = JSON.stringify({
        response: '{}',
        toolName: 'get_weather',
        args: {},
        storedAt: Date.now(),
      });
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue(stored);

      await cache.check('get_weather', {});

      // Stats are now batched via pipeline
      const hincrbyCalls = (client as unknown as { _hincrbyCalls: Array<[string, string, number]> })._hincrbyCalls;
      expect(hincrbyCalls).toContainEqual(['test_ac:__stats', 'tool:hits', 1]);
      expect(hincrbyCalls).toContainEqual(['test_ac:__stats', 'tool:get_weather:hits', 1]);
    });

    it('records tier-level and per-tool miss via pipeline', async () => {
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await cache.check('get_weather', {});

      // Stats are now batched via pipeline
      const hincrbyCalls = (client as unknown as { _hincrbyCalls: Array<[string, string, number]> })._hincrbyCalls;
      expect(hincrbyCalls).toContainEqual(['test_ac:__stats', 'tool:misses', 1]);
      expect(hincrbyCalls).toContainEqual(['test_ac:__stats', 'tool:get_weather:misses', 1]);
    });

    it('tracks cost savings on hit when entry has cost via pipeline', async () => {
      const stored = JSON.stringify({
        response: '{"temp": 20}',
        toolName: 'expensive_api',
        args: {},
        storedAt: Date.now(),
        cost: 0.05, // $0.05
      });
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue(stored);

      await cache.check('expensive_api', {});

      // Stats are now batched via pipeline - verify cost_saved_micros ($0.05 = 50000 microdollars)
      const hincrbyCalls = (client as unknown as { _hincrbyCalls: Array<[string, string, number]> })._hincrbyCalls;
      expect(hincrbyCalls).toContainEqual(['test_ac:__stats', 'cost_saved_micros', 50000]);
      expect(hincrbyCalls).toContainEqual(['test_ac:__stats', 'tool:expensive_api:cost_saved_micros', 50000]);
    });

    it('does not track cost savings on hit when entry has no cost', async () => {
      const stored = JSON.stringify({
        response: '{"temp": 20}',
        toolName: 'get_weather',
        args: {},
        storedAt: Date.now(),
        // No cost field
      });
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue(stored);

      await cache.check('get_weather', {});

      // cost_saved_micros should not be in pipeline calls
      const hincrbyCalls = (client as unknown as { _hincrbyCalls: Array<[string, string, number]> })._hincrbyCalls;
      const costSavedCalls = hincrbyCalls.filter(
        (call: [string, string, number]) => call[1].includes('cost_saved_micros')
      );
      expect(costSavedCalls.length).toBe(0);
    });
  });

  describe('store()', () => {
    it('uses per-tool policy TTL with SET EX when set', async () => {
      (client.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
      (client.hset as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      await cache.setPolicy('get_weather', { ttl: 120 });

      await cache.store('get_weather', { city: 'Sofia' }, '{"temp": 20}');

      expect(client.set).toHaveBeenCalledWith(
        expect.stringContaining('test_ac:tool:get_weather:'),
        expect.any(String),
        'EX',
        120,
      );
    });

    it('falls back through TTL hierarchy with SET EX: per-call -> policy -> tier -> default', async () => {
      (client.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

      // No policy, no per-call TTL - should use tier TTL (300)
      await cache.store('search', {}, 'result');

      expect(client.set).toHaveBeenCalledWith(
        expect.stringContaining('test_ac:tool:search:'),
        expect.any(String),
        'EX',
        300,
      );
    });

    it('stores cost in entry when provided (but does not track yet)', async () => {
      (client.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

      await cache.store('expensive_api', {}, 'result', { cost: 0.05 });

      // Verify cost is stored in the entry
      const [, value] = (client.set as ReturnType<typeof vi.fn>).mock.calls[0];
      const parsed = JSON.parse(value);
      expect(parsed.cost).toBe(0.05);

      // Verify cost_saved_micros is NOT incremented at store time
      const hincrbyCalls = (client.hincrby as ReturnType<typeof vi.fn>).mock.calls;
      const costSavedCalls = hincrbyCalls.filter(
        (call: unknown[]) => call[1] === 'cost_saved_micros' || (call[1] as string).includes('cost_saved_micros')
      );
      expect(costSavedCalls.length).toBe(0);
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
