import type { InfoTarget, InstanceKey, OtlpKeyValue, OtlpNumberDataPoint } from './otlp-metrics-types';

export interface MappedPoint {
  target: InfoTarget;
  value: string;
}

const SCALARS: Record<string, readonly [string, string]> = {
  'memory.used': ['memory', 'used_memory'],
  'memory.rss': ['memory', 'used_memory_rss'],
  'memory.peak': ['memory', 'used_memory_peak'],
  'memory.lua': ['memory', 'used_memory_lua'],
  'memory.fragmentation_ratio': ['memory', 'mem_fragmentation_ratio'],
  'memory.used_memory_overhead': ['memory', 'used_memory_overhead'],
  'memory.used_memory_startup': ['memory', 'used_memory_startup'],
  maxmemory: ['memory', 'maxmemory'],
  commands: ['stats', 'instantaneous_ops_per_sec'],
  'commands.processed': ['stats', 'total_commands_processed'],
  'connections.received': ['stats', 'total_connections_received'],
  'connections.rejected': ['stats', 'rejected_connections'],
  'keys.evicted': ['stats', 'evicted_keys'],
  'keys.expired': ['stats', 'expired_keys'],
  'keyspace.hits': ['stats', 'keyspace_hits'],
  'keyspace.misses': ['stats', 'keyspace_misses'],
  'net.input': ['stats', 'total_net_input_bytes'],
  'net.output': ['stats', 'total_net_output_bytes'],
  latest_fork: ['stats', 'latest_fork_usec'],
  'clients.connected': ['clients', 'connected_clients'],
  'clients.blocked': ['clients', 'blocked_clients'],
  'clients.max_input_buffer': ['clients', 'client_recent_max_input_buffer'],
  'clients.max_output_buffer': ['clients', 'client_recent_max_output_buffer'],
  'slaves.connected': ['replication', 'connected_slaves'],
  'replication.offset': ['replication', 'master_repl_offset'],
  'replication.backlog_first_byte_offset': ['replication', 'repl_backlog_first_byte_offset'],
  uptime: ['server', 'uptime_in_seconds'],
  'rdb.changes_since_last_save': ['persistence', 'rdb_changes_since_last_save'],
};

const CPU_STATES = new Set([
  'sys',
  'sys_children',
  'sys_main_thread',
  'user',
  'user_children',
  'user_main_thread',
]);

const ROLES: Record<string, string> = { primary: 'master', replica: 'slave' };

const KEYSPACE_SUBKEYS: Record<string, string> = {
  'db.keys': 'keys',
  'db.expires': 'expires',
  'db.avg_ttl': 'avg_ttl',
};

const COMMAND_SUBKEYS: Record<string, string> = {
  'cmd.calls': 'calls',
  'cmd.usec': 'usec',
};

function lookup<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

const DB_PATTERN = /^\d+$/;
const CMD_PATTERN = /^[A-Za-z0-9_|.-]+$/;
const PREFIXES = ['redis.', 'valkey.'] as const;

export function metricVocabulary(name: string): 'redis' | 'valkey' | null {
  if (name.startsWith('redis.')) return 'redis';
  if (name.startsWith('valkey.')) return 'valkey';
  return null;
}

function stripPrefix(name: string): string | null {
  const prefix = PREFIXES.find((p) => name.startsWith(p));
  return prefix ? name.slice(prefix.length) : null;
}

export function mapDataPoint(
  name: string,
  attrs: Record<string, string>,
  value: string,
): MappedPoint | 'ignored' | null {
  const suffix = stripPrefix(name);
  if (suffix === null) return null;

  const scalar = lookup(SCALARS, suffix);
  if (scalar) return { target: { kind: 'scalar', section: scalar[0], field: scalar[1] }, value };

  if (suffix === 'cpu.time') {
    const state = attrs.state;
    if (!state || !CPU_STATES.has(state)) return null;
    return { target: { kind: 'scalar', section: 'cpu', field: `used_cpu_${state}` }, value };
  }

  if (suffix === 'role') {
    const role = lookup(ROLES, attrs.role ?? '');
    if (!role) return null;
    if (Number(value) !== 1) return 'ignored';
    return { target: { kind: 'scalar', section: 'replication', field: 'role' }, value: role };
  }

  const keyspaceSubkey = lookup(KEYSPACE_SUBKEYS, suffix);
  if (keyspaceSubkey) {
    const db = attrs.db;
    if (!db || !DB_PATTERN.test(db)) return null;
    return {
      target: { kind: 'composite', section: 'keyspace', field: `db${db}`, subkey: keyspaceSubkey },
      value,
    };
  }

  const commandSubkey = lookup(COMMAND_SUBKEYS, suffix);
  if (commandSubkey) {
    const cmd = attrs.cmd;
    if (!cmd || !CMD_PATTERN.test(cmd)) return null;
    return {
      target: { kind: 'composite', section: 'commandstats', field: `cmdstat_${cmd}`, subkey: commandSubkey },
      value,
    };
  }

  return null;
}

export function attrsToRecord(kvs: OtlpKeyValue[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of kvs ?? []) {
    const v = kv.value;
    if (!v) continue;
    if (v.stringValue !== undefined) out[kv.key] = v.stringValue;
    else if (v.intValue !== undefined) out[kv.key] = String(v.intValue);
    else if (v.doubleValue !== undefined) out[kv.key] = String(v.doubleValue);
    else if (v.boolValue !== undefined) out[kv.key] = String(v.boolValue);
  }
  return out;
}

function toInstanceKey(host: string, portRaw: string): InstanceKey | null {
  if (!host || !/^\d+$/.test(portRaw)) return null;
  const port = Number(portRaw);
  if (port < 1 || port > 65535) return null;
  return { host, port };
}

function splitInstanceId(id: string): InstanceKey | null {
  const colon = id.lastIndexOf(':');
  if (colon > 0) return toInstanceKey(id.slice(0, colon), id.slice(colon + 1));
  const match = /^(.+)-(\d+)$/.exec(id);
  return match ? toInstanceKey(match[1], match[2]) : null;
}

export function resolveInstanceKey(attrs: Record<string, string>): InstanceKey | null {
  const instanceId = attrs['service.instance.id'];
  if (instanceId) {
    const key = splitInstanceId(instanceId);
    if (key) return key;
  }
  const host = attrs['server.address'];
  const port = attrs['server.port'];
  if (host && port !== undefined) return toInstanceKey(host, port);
  return null;
}

export function pointValue(dp: OtlpNumberDataPoint): string | null {
  if (dp.asInt !== undefined && dp.asInt !== null) {
    const s = String(dp.asInt);
    return /^-?\d+$/.test(s) ? s : null;
  }
  if (typeof dp.asDouble === 'number' && Number.isFinite(dp.asDouble)) return String(dp.asDouble);
  return null;
}

export function nanosToMs(v: string | number | undefined): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') {
    const ms = Math.floor(v / 1e6);
    return ms > 0 ? ms : null;
  }
  if (!/^\d+$/.test(v)) return null;
  const ms = Number(BigInt(v) / 1_000_000n);
  return ms > 0 ? ms : null;
}
