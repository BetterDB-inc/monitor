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

  it.each(['abc', '999', '1500.5'])('rejects %s the same way the boot schema does', (raw) => {
    process.env.OTEL_METRICS_STALE_AFTER_MS = raw;
    expect(envSchema.safeParse({ OTEL_METRICS_STALE_AFTER_MS: raw }).success).toBe(false);
    expect(() => new ExternalMetricsStore()).toThrow();
  });
});

describe('ExternalMetricsStore', () => {
  const saved = process.env.OTEL_METRICS_STALE_AFTER_MS;
  let store: ExternalMetricsStore;

  beforeEach(() => {
    process.env.OTEL_METRICS_STALE_AFTER_MS = '60000';
    store = new ExternalMetricsStore();
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.OTEL_METRICS_STALE_AFTER_MS;
    else process.env.OTEL_METRICS_STALE_AFTER_MS = saved;
  });

  it('reads the stale window from the environment', () => {
    expect(store.staleAfterMs).toBe(60_000);
  });

  it('merges scalars across batches and reports the latest version', () => {
    expect(store.apply('c', [scalar('memory', 'used_memory', '100')])).toBe(1);
    expect(store.apply('c', [scalar('clients', 'connected_clients', '5', T0 + 10)])).toBe(1);
    expect(store.snapshot('c', T0 + 20)).toEqual({
      memory: { used_memory: '100' },
      clients: { connected_clients: '5' },
    });
    expect(store.latestVersion('c')).toBe(T0 + 10);
  });

  it('ignores a point older than the stored one without counting it', () => {
    store.apply('c', [scalar('memory', 'used_memory', '200', T0 + 5)]);
    expect(store.apply('c', [scalar('memory', 'used_memory', '100', T0)])).toBe(0);
    expect(store.snapshot('c', T0 + 5).memory).toEqual({ used_memory: '200' });
    expect(store.latestVersion('c')).toBe(T0 + 5);
  });

  it('overwrites a point with the same timestamp', () => {
    store.apply('c', [scalar('memory', 'used_memory', '100')]);
    expect(store.apply('c', [scalar('memory', 'used_memory', '150')])).toBe(1);
    expect(store.snapshot('c', T0).memory).toEqual({ used_memory: '150' });
  });

  it('expires fields individually', () => {
    store.apply('c', [scalar('memory', 'used_memory', '1', T0), scalar('stats', 'evicted_keys', '2', T0 + 30_000)]);
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
    store.apply('c', [
      composite('keyspace', 'db2', 'keys', '5', T0),
      composite('keyspace', 'db2', 'expires', '1', T0 + 50_000),
    ]);
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
