import {
  attrsToRecord,
  mapDataPoint,
  metricVocabulary,
  nanosToMs,
  pointValue,
  resolveInstanceKey,
} from '../otlp-metric-map';
import type { OtlpKeyValue } from '../otlp-metrics-types';

const scalar = (section: string, field: string, value: string) => ({
  target: { kind: 'scalar', section, field },
  value,
});

describe('mapDataPoint scalars', () => {
  it.each([
    ['memory.used', 'memory', 'used_memory'],
    ['memory.rss', 'memory', 'used_memory_rss'],
    ['memory.peak', 'memory', 'used_memory_peak'],
    ['memory.lua', 'memory', 'used_memory_lua'],
    ['memory.fragmentation_ratio', 'memory', 'mem_fragmentation_ratio'],
    ['memory.used_memory_overhead', 'memory', 'used_memory_overhead'],
    ['memory.used_memory_startup', 'memory', 'used_memory_startup'],
    ['maxmemory', 'memory', 'maxmemory'],
    ['commands', 'stats', 'instantaneous_ops_per_sec'],
    ['commands.processed', 'stats', 'total_commands_processed'],
    ['connections.received', 'stats', 'total_connections_received'],
    ['connections.rejected', 'stats', 'rejected_connections'],
    ['keys.evicted', 'stats', 'evicted_keys'],
    ['keys.expired', 'stats', 'expired_keys'],
    ['keyspace.hits', 'stats', 'keyspace_hits'],
    ['keyspace.misses', 'stats', 'keyspace_misses'],
    ['net.input', 'stats', 'total_net_input_bytes'],
    ['net.output', 'stats', 'total_net_output_bytes'],
    ['latest_fork', 'stats', 'latest_fork_usec'],
    ['clients.connected', 'clients', 'connected_clients'],
    ['clients.blocked', 'clients', 'blocked_clients'],
    ['clients.max_input_buffer', 'clients', 'client_recent_max_input_buffer'],
    ['clients.max_output_buffer', 'clients', 'client_recent_max_output_buffer'],
    ['slaves.connected', 'replication', 'connected_slaves'],
    ['replication.offset', 'replication', 'master_repl_offset'],
    ['replication.backlog_first_byte_offset', 'replication', 'repl_backlog_first_byte_offset'],
    ['uptime', 'server', 'uptime_in_seconds'],
    ['rdb.changes_since_last_save', 'persistence', 'rdb_changes_since_last_save'],
  ])('%s → %s.%s under both vocabularies', (suffix, section, field) => {
    expect(mapDataPoint(`redis.${suffix}`, {}, '42')).toEqual(scalar(section, field, '42'));
    expect(mapDataPoint(`valkey.${suffix}`, {}, '42')).toEqual(scalar(section, field, '42'));
  });
});

describe('mapDataPoint cpu.time', () => {
  it.each(['sys', 'sys_children', 'sys_main_thread', 'user', 'user_children', 'user_main_thread'])(
    'maps state %s',
    (state) => {
      expect(mapDataPoint('redis.cpu.time', { state }, '1.5')).toEqual(
        scalar('cpu', `used_cpu_${state}`, '1.5'),
      );
    },
  );

  it('rejects an unknown or missing state', () => {
    expect(mapDataPoint('redis.cpu.time', { state: 'idle' }, '1')).toBeNull();
    expect(mapDataPoint('redis.cpu.time', {}, '1')).toBeNull();
  });
});

describe('mapDataPoint role', () => {
  it('maps primary and replica when the value is 1', () => {
    expect(mapDataPoint('redis.role', { role: 'primary' }, '1')).toEqual(scalar('replication', 'role', 'master'));
    expect(mapDataPoint('valkey.role', { role: 'replica' }, '1')).toEqual(scalar('replication', 'role', 'slave'));
  });

  it('ignores a role point whose value is not 1', () => {
    expect(mapDataPoint('redis.role', { role: 'primary' }, '0')).toBe('ignored');
  });

  it('rejects an unknown role', () => {
    expect(mapDataPoint('redis.role', { role: 'sentinel' }, '1')).toBeNull();
  });
});

describe('mapDataPoint composites', () => {
  it.each([
    ['db.keys', 'keys'],
    ['db.expires', 'expires'],
    ['db.avg_ttl', 'avg_ttl'],
  ])('%s → keyspace.db<N>.%s', (suffix, subkey) => {
    expect(mapDataPoint(`redis.${suffix}`, { db: '3' }, '7')).toEqual({
      target: { kind: 'composite', section: 'keyspace', field: 'db3', subkey },
      value: '7',
    });
  });

  it.each([
    ['cmd.calls', 'calls'],
    ['cmd.usec', 'usec'],
  ])('%s → commandstats.cmdstat_<cmd>.%s', (suffix, subkey) => {
    expect(mapDataPoint(`valkey.${suffix}`, { cmd: 'client|list' }, '9')).toEqual({
      target: { kind: 'composite', section: 'commandstats', field: 'cmdstat_client|list', subkey },
      value: '9',
    });
  });

  it('rejects invalid db and cmd attributes', () => {
    expect(mapDataPoint('redis.db.keys', { db: 'db0' }, '1')).toBeNull();
    expect(mapDataPoint('redis.db.keys', {}, '1')).toBeNull();
    expect(mapDataPoint('redis.cmd.calls', { cmd: 'get\r\nset' }, '1')).toBeNull();
    expect(mapDataPoint('redis.cmd.calls', {}, '1')).toBeNull();
  });
});

describe('mapDataPoint unmapped', () => {
  it.each([
    'redis.cmd.latency',
    'redis.cluster.state',
    'redis.sentinel.masters',
    'redis.pubsub.channels',
    'redis.mode',
    'redis.tracking_total_keys',
    'memcached.memory.used',
    'memory.used',
  ])('%s is unmapped', (name) => {
    expect(mapDataPoint(name, {}, '1')).toBeNull();
  });
});

describe('metricVocabulary', () => {
  it('reports the prefix', () => {
    expect(metricVocabulary('redis.memory.used')).toBe('redis');
    expect(metricVocabulary('valkey.memory.used')).toBe('valkey');
    expect(metricVocabulary('memory.used')).toBeNull();
  });
});

describe('resolveInstanceKey', () => {
  it('prefers service.instance.id split at the last colon', () => {
    expect(
      resolveInstanceKey({ 'service.instance.id': 'cache-a.internal:6380', 'server.address': 'x', 'server.port': '1' }),
    ).toEqual({ host: 'cache-a.internal', port: 6380 });
  });

  it('splits the Valkey Admin host-port form at the trailing digits', () => {
    expect(resolveInstanceKey({ 'service.instance.id': 'my-cache-host-6379' })).toEqual({
      host: 'my-cache-host',
      port: 6379,
    });
  });

  it('falls back to server.address and server.port', () => {
    expect(resolveInstanceKey({ 'server.address': '10.0.0.5', 'server.port': '6379' })).toEqual({
      host: '10.0.0.5',
      port: 6379,
    });
  });

  it('falls back when service.instance.id cannot be parsed', () => {
    expect(
      resolveInstanceKey({ 'service.instance.id': 'b9f0c2', 'server.address': 'h', 'server.port': '7000' }),
    ).toEqual({ host: 'h', port: 7000 });
  });

  it('returns null without an identity or with an invalid port', () => {
    expect(resolveInstanceKey({})).toBeNull();
    expect(resolveInstanceKey({ 'server.address': 'h' })).toBeNull();
    expect(resolveInstanceKey({ 'server.address': 'h', 'server.port': '0' })).toBeNull();
    expect(resolveInstanceKey({ 'server.address': 'h', 'server.port': '70000' })).toBeNull();
    expect(resolveInstanceKey({ 'service.instance.id': 'host:abc' })).toBeNull();
  });
});

describe('attrsToRecord', () => {
  it('stringifies every AnyValue kind and skips empty values', () => {
    expect(
      attrsToRecord([
        { key: 's', value: { stringValue: 'a' } },
        { key: 'i', value: { intValue: '6379' } },
        { key: 'n', value: { intValue: 6380 } },
        { key: 'd', value: { doubleValue: 1.5 } },
        { key: 'b', value: { boolValue: true } },
        { key: 'none' },
      ]),
    ).toEqual({ s: 'a', i: '6379', n: '6380', d: '1.5', b: 'true' });
    expect(attrsToRecord(undefined)).toEqual({});
  });

  it('ignores values whose type does not match their variant', () => {
    const malformed = [
      { key: 'service.instance.id', value: { stringValue: 42 } },
      { key: 'i', value: { intValue: { high: 1 } } },
      { key: 'd', value: { doubleValue: '1.5' } },
      { key: 'b', value: { boolValue: 'true' } },
      { key: 7, value: { stringValue: 'x' } },
      null,
      { key: 'ok', value: { stringValue: 'y' } },
    ] as unknown as OtlpKeyValue[];
    expect(attrsToRecord(malformed)).toEqual({ ok: 'y' });
  });
});

describe('pointValue', () => {
  it('keeps asInt exact and prints doubles at full precision', () => {
    expect(pointValue({ asInt: '9007199254740993' })).toBe('9007199254740993');
    expect(pointValue({ asInt: 12 })).toBe('12');
    expect(pointValue({ asDouble: 1.25 })).toBe('1.25');
    expect(pointValue({ asDouble: 1024 })).toBe('1024');
    expect(pointValue({ asInt: '0' })).toBe('0');
  });

  it('returns null for missing or non-finite values', () => {
    expect(pointValue({})).toBeNull();
    expect(pointValue({ asDouble: 'NaN' })).toBeNull();
    expect(pointValue({ asDouble: Number.POSITIVE_INFINITY })).toBeNull();
    expect(pointValue({ asInt: '1.5' })).toBeNull();
  });
});

describe('nanosToMs', () => {
  it('converts strings exactly and numbers by division', () => {
    expect(nanosToMs('1700000000123456789')).toBe(1700000000123);
    expect(nanosToMs(1_700_000_000_000_000_000)).toBe(1700000000000);
  });

  it('returns null for missing, zero or invalid values', () => {
    expect(nanosToMs(undefined)).toBeNull();
    expect(nanosToMs('0')).toBeNull();
    expect(nanosToMs(0)).toBeNull();
    expect(nanosToMs('abc')).toBeNull();
  });
});
