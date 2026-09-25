import { ExternalMetricsStore } from '../external-metrics-store';
import { envSchema } from '../../config/env.schema';
import type { FieldUpdate } from '../otlp-metrics-types';

const T0 = 1_700_000_000_000;

const scalar = (section: string, field: string, value: string, timeMs = T0): FieldUpdate => ({
  target: { kind: 'scalar', section, field },
  value,
  timeMs,
});

const composite = (
  section: 'keyspace' | 'commandstats',
  field: string,
  subkey: string,
  value: string,
  timeMs = T0,
): FieldUpdate => ({ target: { kind: 'composite', section, field, subkey }, value, timeMs });

describe('ExternalMetricsStore stale window', () => {
  const saved = process.env.OTEL_METRICS_STALE_AFTER_MS;

  afterEach(() => {
    if (saved === undefined) delete process.env.OTEL_METRICS_STALE_AFTER_MS;
    else process.env.OTEL_METRICS_STALE_AFTER_MS = saved;
  });

  it('defaults to 300000 when unset', () => {
    delete process.env.OTEL_METRICS_STALE_AFTER_MS;
    expect(new ExternalMetricsStore().staleAfterMs).toBe(300_000);
  });

  it.each(['abc', '999', '1500.5', '30000', '59999'])('rejects %s the same way the boot schema does', (raw) => {
    process.env.OTEL_METRICS_STALE_AFTER_MS = raw;
    expect(envSchema.safeParse({ OTEL_METRICS_STALE_AFTER_MS: raw }).success).toBe(false);
    expect(() => new ExternalMetricsStore()).toThrow();
  });

  it('accepts the 60000 minimum', () => {
    process.env.OTEL_METRICS_STALE_AFTER_MS = '60000';
    expect(new ExternalMetricsStore().staleAfterMs).toBe(60_000);
  });

  it('explains that the window must exceed the exporter push interval', () => {
    const result = envSchema.safeParse({ OTEL_METRICS_STALE_AFTER_MS: '30000' });
    const issue = result.error?.issues.find((i) => i.path[0] === 'OTEL_METRICS_STALE_AFTER_MS');
    expect(issue?.message).toMatch(/push interval/);
  });
});

describe('ExternalMetricsStore', () => {
  const saved = process.env.OTEL_METRICS_STALE_AFTER_MS;
  let store: ExternalMetricsStore;

  beforeEach(() => {
    process.env.OTEL_METRICS_STALE_AFTER_MS = '60000';
    jest.spyOn(Date, 'now').mockReturnValue(T0);
    store = new ExternalMetricsStore();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.OTEL_METRICS_STALE_AFTER_MS;
    else process.env.OTEL_METRICS_STALE_AFTER_MS = saved;
  });

  it('reads the stale window from the environment', () => {
    expect(store.staleAfterMs).toBe(60_000);
  });

  it('merges scalars across batches and advances the version', () => {
    expect(store.apply('c', [scalar('memory', 'used_memory', '100')]).accepted).toBe(1);
    const first = store.latestVersion('c');
    expect(store.apply('c', [scalar('clients', 'connected_clients', '5', T0 + 10)]).accepted).toBe(1);
    expect(store.snapshot('c', T0 + 20)).toEqual({
      memory: { used_memory: '100' },
      clients: { connected_clients: '5' },
    });
    expect(first).not.toBeNull();
    expect(store.latestVersion('c')).toBeGreaterThan(first as number);
  });

  it('ignores a point older than the stored one without counting it', () => {
    store.apply('c', [scalar('memory', 'used_memory', '200', T0 + 5)]);
    const version = store.latestVersion('c');
    expect(store.apply('c', [scalar('memory', 'used_memory', '100', T0)]).accepted).toBe(0);
    expect(store.snapshot('c', T0 + 5).memory).toEqual({ used_memory: '200' });
    expect(store.latestVersion('c')).toBe(version);
  });

  describe('composite cardinality', () => {
    const commands = (count: number, timeMs: number, prefix = 'c') =>
      Array.from({ length: count }, (_, i) => composite('commandstats', `cmdstat_${prefix}${i}`, 'calls', '1', timeMs));
    const dbs = (count: number, timeMs: number, offset = 0) =>
      Array.from({ length: count }, (_, i) => composite('keyspace', `db${offset + i}`, 'keys', '1', timeMs));

    it('caps commandstats at 1024 entries and rejects points for new commands beyond it', () => {
      expect(store.apply('c', commands(1024, T0), T0)).toEqual({ accepted: 1024, rejected: 0 });
      const over = [
        composite('commandstats', 'cmdstat_extra', 'calls', '1'),
        composite('commandstats', 'cmdstat_extra', 'usec', '5'),
        composite('commandstats', 'cmdstat_c0', 'usec', '5'),
      ];
      expect(store.apply('c', over, T0)).toEqual({ accepted: 1, rejected: 2 });
      const rendered = store.snapshot('c', T0).commandstats ?? {};
      expect(Object.keys(rendered)).toHaveLength(1024);
      expect(rendered.cmdstat_extra).toBeUndefined();
      expect(rendered.cmdstat_c0).toBe('calls=1,usec=5,usec_per_call=5.00');
    });

    it('caps keyspace at 256 entries independently of commandstats', () => {
      store.apply('c', commands(1024, T0), T0);
      expect(store.apply('c', dbs(257, T0), T0)).toEqual({ accepted: 256, rejected: 1 });
      expect(Object.keys(store.snapshot('c', T0).keyspace ?? {})).toHaveLength(256);
    });

    it('caps each connection separately', () => {
      store.apply('a', dbs(256, T0), T0);
      expect(store.apply('b', dbs(1, T0), T0)).toEqual({ accepted: 1, rejected: 0 });
    });

    it('frees the slots of entries whose subkeys are all stale', () => {
      store.apply('c', commands(1024, T0), T0);
      const later = T0 + 60_001;
      expect(store.apply('c', commands(1024, later, 'n'), later)).toEqual({ accepted: 1024, rejected: 0 });
    });

    it('keeps the slot of an entry with any fresh subkey', () => {
      store.apply('c', commands(1024, T0), T0);
      store.apply('c', [composite('commandstats', 'cmdstat_c0', 'usec', '5', T0 + 50_000)], T0 + 50_000);
      const later = T0 + 60_001;
      expect(store.apply('c', commands(1024, later, 'n'), later)).toEqual({ accepted: 1023, rejected: 1 });
    });

    it('does not advance the version for rejected points', () => {
      store.apply('c', dbs(256, T0), T0);
      const before = store.latestVersion('c');
      store.apply('c', dbs(1, T0, 300), T0);
      expect(store.latestVersion('c')).toBe(before);
    });
  });

  describe('sample version', () => {
    it('stays null until data is stored', () => {
      store.apply('c', []);
      expect(store.latestVersion('c')).toBeNull();
    });

    it('advances when a new field arrives at the same timestamp', () => {
      store.apply('c', [scalar('memory', 'used_memory', '1')]);
      const before = store.latestVersion('c') as number;
      store.apply('c', [scalar('memory', 'used_memory_rss', '2')]);
      expect(store.latestVersion('c')).toBeGreaterThan(before);
    });

    it('advances when a value changes at the same timestamp', () => {
      store.apply('c', [composite('keyspace', 'db0', 'keys', '1')]);
      const before = store.latestVersion('c') as number;
      store.apply('c', [composite('keyspace', 'db0', 'keys', '2')]);
      expect(store.latestVersion('c')).toBeGreaterThan(before);
    });

    it('advances when the same value arrives with a newer timestamp', () => {
      store.apply('c', [scalar('memory', 'used_memory', '1')]);
      const before = store.latestVersion('c') as number;
      store.apply('c', [scalar('memory', 'used_memory', '1', T0 + 1)]);
      expect(store.latestVersion('c')).toBeGreaterThan(before);
    });

    it('does not advance on an exact duplicate but still accepts it', () => {
      store.apply('c', [scalar('memory', 'used_memory', '1'), composite('keyspace', 'db0', 'keys', '3')]);
      const before = store.latestVersion('c');
      expect(store.apply('c', [scalar('memory', 'used_memory', '1'), composite('keyspace', 'db0', 'keys', '3')]).accepted).toBe(2);
      expect(store.latestVersion('c')).toBe(before);
    });

    it('never reuses a version after the connection is cleared', () => {
      store.apply('c', [scalar('memory', 'used_memory', '1')]);
      const before = store.latestVersion('c') as number;
      store.clear('c');
      store.apply('c', [scalar('memory', 'used_memory', '1')]);
      expect(store.latestVersion('c')).toBeGreaterThan(before);
    });
  });

  describe('freshness agrees with the snapshot', () => {
    it('is not fresh when a keyspace entry only has expires', () => {
      store.apply('c', [composite('keyspace', 'db0', 'expires', '3')]);
      expect(store.snapshot('c', T0)).toEqual({});
      expect(store.isFresh('c', T0)).toBe(false);
    });

    it('is not fresh when a commandstats entry only has usec', () => {
      store.apply('c', [composite('commandstats', 'cmdstat_get', 'usec', '10')]);
      expect(store.snapshot('c', T0)).toEqual({});
      expect(store.isFresh('c', T0)).toBe(false);
    });

    it('is not fresh once the primary subkey ages out before the others', () => {
      store.apply('c', [composite('keyspace', 'db0', 'keys', '5', T0)], T0);
      store.apply('c', [composite('keyspace', 'db0', 'expires', '1', T0 + 50_000)], T0 + 50_000);
      expect(store.isFresh('c', T0 + 60_000)).toBe(true);
      expect(store.snapshot('c', T0 + 60_001)).toEqual({});
      expect(store.isFresh('c', T0 + 60_001)).toBe(false);
    });

    it('is fresh when a composite primary subkey is fresh', () => {
      store.apply('c', [composite('commandstats', 'cmdstat_get', 'calls', '4')]);
      expect(store.isFresh('c', T0)).toBe(true);
    });

    it('ignores the server version when nothing else is fresh', () => {
      store.setServerVersion('c', '7.2.4');
      store.apply('c', [composite('keyspace', 'db0', 'expires', '3')]);
      expect(store.isFresh('c', T0)).toBe(false);
    });
  });

  describe('freshness follows receipt time', () => {
    it('keeps a point received now fresh even when its own timestamp is old', () => {
      store.apply('c', [scalar('memory', 'used_memory', '1', T0 - 600_000)], T0);
      expect(store.isFresh('c', T0 + 60_000)).toBe(true);
      expect(store.snapshot('c', T0 + 60_000)).toEqual({ memory: { used_memory: '1' } });
      expect(store.isFresh('c', T0 + 60_001)).toBe(false);
      expect(store.snapshot('c', T0 + 60_001)).toEqual({});
    });

    it('refreshes freshness when an exact duplicate is received again', () => {
      store.apply('c', [scalar('memory', 'used_memory', '1')], T0);
      store.apply('c', [scalar('memory', 'used_memory', '1')], T0 + 50_000);
      expect(store.isFresh('c', T0 + 110_000)).toBe(true);
      expect(store.snapshot('c', T0 + 110_000)).toEqual({ memory: { used_memory: '1' } });
    });

    it('does not refresh freshness for an older point it ignores', () => {
      store.apply('c', [scalar('memory', 'used_memory', '2', T0)], T0);
      store.apply('c', [scalar('memory', 'used_memory', '1', T0 - 10)], T0 + 50_000);
      expect(store.isFresh('c', T0 + 60_001)).toBe(false);
    });
  });

  it('overwrites a point with the same timestamp', () => {
    store.apply('c', [scalar('memory', 'used_memory', '100')]);
    expect(store.apply('c', [scalar('memory', 'used_memory', '150')]).accepted).toBe(1);
    expect(store.snapshot('c', T0).memory).toEqual({ used_memory: '150' });
  });

  it('expires fields individually', () => {
    store.apply('c', [scalar('memory', 'used_memory', '1', T0)], T0);
    store.apply('c', [scalar('stats', 'evicted_keys', '2', T0 + 30_000)], T0 + 30_000);
    expect(store.snapshot('c', T0 + 60_000)).toEqual({ memory: { used_memory: '1' }, stats: { evicted_keys: '2' } });
    expect(store.snapshot('c', T0 + 60_001)).toEqual({ stats: { evicted_keys: '2' } });
    expect(store.isFresh('c', T0 + 90_000)).toBe(true);
    expect(store.isFresh('c', T0 + 90_001)).toBe(false);
    expect(store.snapshot('c', T0 + 90_001)).toEqual({});
  });

  it('renders keyspace composites from fresh subkeys, keys first', () => {
    store.apply('c', [
      composite('keyspace', 'db0', 'avg_ttl', '0'),
      composite('keyspace', 'db0', 'expires', '3'),
      composite('keyspace', 'db0', 'keys', '10'),
    ]);
    expect(store.snapshot('c', T0).keyspace).toEqual({ db0: 'keys=10,expires=3,avg_ttl=0' });
  });

  it('omits a composite whose primary subkey is stale or missing', () => {
    store.apply('c', [composite('keyspace', 'db1', 'expires', '3')]);
    expect(store.snapshot('c', T0).keyspace).toBeUndefined();
    store.apply('c', [composite('keyspace', 'db2', 'keys', '5', T0)], T0);
    store.apply('c', [composite('keyspace', 'db2', 'expires', '1', T0 + 50_000)], T0 + 50_000);
    expect(store.snapshot('c', T0 + 60_001).keyspace).toBeUndefined();
  });

  it('renders commandstats with a derived usec_per_call', () => {
    store.apply('c', [composite('commandstats', 'cmdstat_get', 'calls', '4'), composite('commandstats', 'cmdstat_get', 'usec', '10')]);
    expect(store.snapshot('c', T0).commandstats).toEqual({ cmdstat_get: 'calls=4,usec=10,usec_per_call=2.50' });
  });

  it('renders commandstats without usec_per_call when usec is absent or calls is 0', () => {
    store.apply('c', [composite('commandstats', 'cmdstat_set', 'calls', '0'), composite('commandstats', 'cmdstat_set', 'usec', '0')]);
    store.apply('c', [composite('commandstats', 'cmdstat_del', 'calls', '2')]);
    expect(store.snapshot('c', T0).commandstats).toEqual({
      cmdstat_set: 'calls=0,usec=0',
      cmdstat_del: 'calls=2',
    });
  });

  it('adds redis_version to server only while some field is fresh', () => {
    store.setServerVersion('c', '7.2.4');
    expect(store.snapshot('c', T0)).toEqual({});
    store.apply('c', [scalar('server', 'uptime_in_seconds', '9')]);
    expect(store.snapshot('c', T0).server).toEqual({ uptime_in_seconds: '9', redis_version: '7.2.4' });
    expect(store.serverVersion('c')).toBe('7.2.4');
  });

  it('tracks the valkey flag and clears everything', () => {
    store.apply('c', [scalar('memory', 'used_memory', '1')]);
    store.markValkey('c');
    store.setServerVersion('c', '8.0.0');
    expect(store.isValkey('c')).toBe(true);
    store.clear('c');
    expect(store.snapshot('c', T0)).toEqual({});
    expect(store.latestVersion('c')).toBeNull();
    expect(store.isValkey('c')).toBe(false);
    expect(store.serverVersion('c')).toBeNull();
  });

  it('returns empty results for an unknown connection', () => {
    expect(store.snapshot('nope', T0)).toEqual({});
    expect(store.isFresh('nope', T0)).toBe(false);
    expect(store.latestVersion('nope')).toBeNull();
  });
});
