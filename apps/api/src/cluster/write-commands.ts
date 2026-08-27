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
 * The list names writes; it cannot name every non-write. Anything absent from
 * both this set and CLIENT_READ_COMMANDS is left for the caller's classifier to
 * resolve against the server, so a core command added after this list was
 * written — or a module command, which is never enumerable — is reported as
 * unclassified rather than silently counted as a read.
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

/**
 * Commands the server flags `write` that a client issuing them is nonetheless
 * reading through. Without this set a server-backed classifier would overturn
 * the deliberate exclusions above and make every healthy replica look like it
 * was taking writes.
 */
const CLIENT_READ_COMMANDS: ReadonlySet<string> = new Set([
  'eval_ro',
  'evalsha_ro',
  'fcall_ro',
  'georadius_ro',
  'georadiusbymember_ro',
  'pfcount',
]);

export interface WriteCallTotals {
  /** Calls across every command known to write. */
  writes: number;
  /** Calls across commands that could not be classified either way. */
  unclassified: number;
}

/**
 * Verdict for a command this module does not name: `true` for a write, `false`
 * for a read, `undefined` when the answer is unavailable.
 */
export type CommandClassifier = (command: string) => boolean | undefined;

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
 * True for a command that reads despite the server flagging it `write`.
 */
export function isClientReadCommand(command: string): boolean {
  return CLIENT_READ_COMMANDS.has(command.toLowerCase());
}

/**
 * Calls the node has served since it started, split into the writes that could
 * be established and the calls that could not be classified either way.
 * Cumulative counters, not rates — the caller diffs them against its own
 * previous reading.
 *
 * The split matters because zero writes alongside unclassified traffic is not
 * the same claim as zero writes on a node proven to serve reads: the first
 * means the attribution failed and the caller should fall back to `opsPerSec`,
 * the second means the node really is taking no writes.
 */
export function sumWriteCalls(
  samples: ReadonlyArray<{ command: string; calls: number }>,
  classify: CommandClassifier,
): WriteCallTotals {
  const totals = { writes: 0, unclassified: 0 };
  for (const sample of samples) {
    if (isWriteCommand(sample.command)) {
      totals.writes += sample.calls;
      continue;
    }
    if (isClientReadCommand(sample.command)) {
      continue;
    }
    const verdict = classify(sample.command);
    if (verdict === true) {
      totals.writes += sample.calls;
      continue;
    }
    if (verdict === false) {
      continue;
    }
    totals.unclassified += sample.calls;
  }
  return totals;
}
