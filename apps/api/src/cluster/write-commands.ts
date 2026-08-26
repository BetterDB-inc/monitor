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
 * Module commands are not enumerated. The detector's fallback is `opsPerSec`,
 * so a node taking only module writes is still reported as taking traffic;
 * it just loses the write-specific attribution.
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
  'hpersist',
  'hpexpire',
  'hpexpireat',
  'hmset',
  'hset',
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
 * Total calls across every write command the node has served since it started.
 * A cumulative counter, not a rate — the caller diffs it against its own
 * previous reading.
 */
export function sumWriteCalls(samples: ReadonlyArray<{ command: string; calls: number }>): number {
  let total = 0;
  for (const sample of samples) {
    if (!isWriteCommand(sample.command)) {
      continue;
    }
    total += sample.calls;
  }
  return total;
}
