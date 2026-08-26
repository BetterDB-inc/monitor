/**
 * Commands that mutate the keyspace, matched against the lowercase names
 * `INFO commandstats` reports as `cmdstat_<name>`.
 *
 * Read-only variants are deliberately absent: `eval_ro`, `evalsha_ro`,
 * `fcall_ro`, `georadius_ro` and `georadiusbymember_ro` exist precisely so a
 * replica can serve them, and counting them would make every healthy replica
 * look like it was taking writes. `pfcount` is flagged `write` by the server
 * because it rewrites its own cached cardinality, but a client issuing it is
 * reading — it stays out for the same reason.
 *
 * Module commands are not enumerated — there is no fixed list of them. They are
 * counted separately instead, so a caller can tell a node that served no writes
 * apart from one whose writes this module cannot name.
 */
const WRITE_COMMANDS: ReadonlySet<string> = new Set([
  'append',
  'bitfield',
  'bitop',
  'blmove',
  'blmpop',
  'blpop',
  'brpop',
  'brpoplpush',
  'bzmpop',
  'bzpopmax',
  'bzpopmin',
  'copy',
  'decr',
  'decrby',
  'del',
  'eval',
  'evalsha',
  'expire',
  'expireat',
  'fcall',
  'flushall',
  'flushdb',
  'geoadd',
  'georadius',
  'georadiusbymember',
  'geosearchstore',
  'getdel',
  'getex',
  'getset',
  'hdel',
  'hexpire',
  'hexpireat',
  'hgetdel',
  'hgetex',
  'hincrby',
  'hincrbyfloat',
  'hmset',
  'hpersist',
  'hpexpire',
  'hpexpireat',
  'hset',
  'hsetex',
  'hsetnx',
  'incr',
  'incrby',
  'incrbyfloat',
  'linsert',
  'lmove',
  'lmpop',
  'lpop',
  'lpush',
  'lpushx',
  'lrem',
  'lset',
  'ltrim',
  'migrate',
  'move',
  'mset',
  'msetnx',
  'persist',
  'pexpire',
  'pexpireat',
  'pfadd',
  'pfmerge',
  'psetex',
  'rename',
  'renamenx',
  'restore',
  'rpop',
  'rpoplpush',
  'rpush',
  'rpushx',
  'sadd',
  'sdiffstore',
  'set',
  'setbit',
  'setex',
  'setnx',
  'setrange',
  'sinterstore',
  'smove',
  'sort',
  'spop',
  'srem',
  'sunionstore',
  'swapdb',
  'unlink',
  'xack',
  'xadd',
  'xautoclaim',
  'xclaim',
  'xdel',
  'xgroup',
  'xreadgroup',
  'xsetid',
  'xtrim',
  'zadd',
  'zdiffstore',
  'zincrby',
  'zinterstore',
  'zmpop',
  'zpopmax',
  'zpopmin',
  'zrangestore',
  'zrem',
  'zremrangebylex',
  'zremrangebyrank',
  'zremrangebyscore',
  'zunionstore',
]);

export interface WriteCallTotals {
  /** Calls across every command this module recognises as a write. */
  writes: number;
  /** Calls across module commands, which carry no classification either way. */
  moduleCalls: number;
}

/**
 * `commandstats` reports container commands as `parent|subcommand`. Every
 * subcommand of a write container is itself a write, and none of the
 * containers that matter here (`xgroup`) mixes reads in, so matching on the
 * parent is enough.
 */
export function isWriteCommand(command: string): boolean {
  const parent = command.toLowerCase().split('|')[0];
  return WRITE_COMMANDS.has(parent);
}

/**
 * Modules namespace their commands with a dot — `json.set`, `ts.add`,
 * `bf.add`. No core command does, and container subcommands use `|`, so the
 * dot is enough to tell a module command from one this module simply reads.
 */
function isModuleCommand(command: string): boolean {
  return command.includes('.');
}

/**
 * Calls the node has served since it started, split into the writes this module
 * can name and the module commands it cannot. Cumulative counters, not rates —
 * the caller diffs them against its own previous reading.
 *
 * The split matters because zero writes alongside module traffic is not the
 * same claim as zero writes on a node serving plain reads: the first means the
 * attribution failed and the caller should fall back to `opsPerSec`, the second
 * means the node really is taking no writes.
 */
export function sumWriteCalls(
  samples: ReadonlyArray<{ command: string; calls: number }>,
): WriteCallTotals {
  const totals = { writes: 0, moduleCalls: 0 };
  for (const sample of samples) {
    if (isWriteCommand(sample.command)) {
      totals.writes += sample.calls;
      continue;
    }
    if (isModuleCommand(sample.command)) {
      totals.moduleCalls += sample.calls;
    }
  }
  return totals;
}
