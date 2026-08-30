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
 * The names whose bucket merges a writing and a non-writing form are absent
 * too; AMBIGUOUS_COMMANDS below holds them.
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

/**
 * Commands whose `commandstats` bucket merges a writing and a non-writing form.
 * `SORT` writes only with `STORE`, `GEORADIUS` and `GEORADIUSBYMEMBER` only
 * with `STORE` or `STOREDIST`, and the bucket keeps the command name, not the
 * options, so it cannot say which form ran.
 *
 * The server flags all three `write`, so the fallback classifier would resolve
 * them the wrong way for the common read-only case and inflate the write count
 * on a node serving nothing but reads. Their calls go to the unclassified total
 * instead, which is where incomplete attribution already belongs. The explicit
 * read-only spellings — `sort_ro`, `georadius_ro`, `georadiusbymember_ro` — are
 * unambiguous and stay named as reads.
 */
const AMBIGUOUS_COMMANDS: ReadonlySet<string> = new Set(['georadius', 'georadiusbymember', 'sort']);

/**
 * Core commands that read the keyspace, plus the introspection this service
 * issues against every node it polls.
 *
 * Naming them matters because `commandstats` is cumulative since the server
 * started, so a single unnamed command name poisons the whole reading: the
 * caller sees zero writes alongside unclassified traffic and falls back to
 * `opsPerSec`. Without this set that fallback is not the exception — the
 * poller's own `INFO` guarantees it on every node whenever `COMMAND INFO` is
 * denied, renamed or otherwise unavailable, so a node serving pure reads
 * raises a write alert.
 *
 * Like the write list this cannot be complete, and it does not need to be: a
 * command absent from both lists is still resolved against the server, and
 * still reported as unclassified when the server has no answer.
 */
const READ_COMMANDS: ReadonlySet<string> = new Set([
  'auth',
  'bitcount',
  'bitfield_ro',
  'bitpos',
  'dbsize',
  'dump',
  'echo',
  'exists',
  'expiretime',
  'geodist',
  'geohash',
  'geopos',
  'geosearch',
  'get',
  'getbit',
  'getrange',
  'hello',
  'hexists',
  'hexpiretime',
  'hget',
  'hgetall',
  'hkeys',
  'hlen',
  'hmget',
  'hpexpiretime',
  'hpttl',
  'hrandfield',
  'hscan',
  'hstrlen',
  'httl',
  'hvals',
  'info',
  'keys',
  'lastsave',
  'lcs',
  'lindex',
  'llen',
  'lolwut',
  'lpos',
  'lrange',
  'mget',
  'pexpiretime',
  'ping',
  'psubscribe',
  'psync',
  'pttl',
  'publish',
  'punsubscribe',
  'randomkey',
  'replconf',
  'reset',
  'scan',
  'scard',
  'sdiff',
  'select',
  'sinter',
  'sintercard',
  'sismember',
  'smembers',
  'smismember',
  'sort_ro',
  'spublish',
  'srandmember',
  'sscan',
  'ssubscribe',
  'strlen',
  'subscribe',
  'substr',
  'sunion',
  'sunsubscribe',
  'sync',
  'time',
  'touch',
  'ttl',
  'type',
  'unsubscribe',
  'wait',
  'waitaof',
  'xlen',
  'xpending',
  'xrange',
  'xread',
  'xrevrange',
  'zcard',
  'zcount',
  'zdiff',
  'zinter',
  'zintercard',
  'zlexcount',
  'zmscore',
  'zrandmember',
  'zrange',
  'zrangebylex',
  'zrangebyscore',
  'zrank',
  'zrevrange',
  'zrevrangebylex',
  'zrevrangebyscore',
  'zrevrank',
  'zscan',
  'zscore',
  'zunion',
]);

/**
 * Container commands whose subcommands never write the keyspace. `CONFIG SET`
 * and `CLUSTER SETSLOT` change the server, not the data a client would lose to
 * a slot-cache refresh, so the whole container is safe to match on the parent
 * the way the write list does.
 *
 * `xgroup` is deliberately absent: it writes, and the write list claims it
 * first.
 */
const NON_KEYSPACE_CONTAINERS: ReadonlySet<string> = new Set([
  'acl',
  'client',
  'cluster',
  'command',
  'config',
  'function',
  'latency',
  'memory',
  'object',
  'pubsub',
  'script',
  'slowlog',
  'xinfo',
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
 * True for a command whose call count cannot be attributed either way, because
 * `commandstats` merges its writing and non-writing forms under one name.
 */
export function isAmbiguousCommand(command: string): boolean {
  return AMBIGUOUS_COMMANDS.has(command.toLowerCase());
}

/**
 * True for a command this module can rule out as a keyspace write without
 * asking the server — either because it plainly reads, or because it reads
 * despite the server flagging it `write`.
 */
export function isReadCommand(command: string): boolean {
  const name = command.toLowerCase();
  if (CLIENT_READ_COMMANDS.has(name) || READ_COMMANDS.has(name)) {
    return true;
  }
  return NON_KEYSPACE_CONTAINERS.has(name.split('|')[0]);
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
    if (isAmbiguousCommand(sample.command)) {
      totals.unclassified += sample.calls;
      continue;
    }
    if (isReadCommand(sample.command)) {
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
