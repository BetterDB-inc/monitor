import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import Valkey from 'iovalkey';

const DOC_PATH = join(__dirname, '../../../docs/minimum-acl.md');
const USER = `betterdb-acl-${randomBytes(4).toString('hex')}`;

type Command = string[];

const BASE_ALLOWED: Command[] = [
  ['PING'],
  ['INFO'],
  ['INFO', 'commandstats'],
  ['SELECT', '1'],
  ['CLIENT', 'SETNAME', 'BetterDB-Monitor'],
  ['CLIENT', 'GETNAME'],
  ['CLIENT', 'LIST'],
  ['CLIENT', 'NO-TOUCH', 'ON'],
  ['CONFIG', 'GET', '*'],
  ['SLOWLOG', 'GET', '128'],
  ['SLOWLOG', 'LEN'],
  ['COMMANDLOG', 'GET', '128', 'slow'],
  ['COMMANDLOG', 'LEN', 'slow'],
  ['LATENCY', 'LATEST'],
  ['LATENCY', 'HISTOGRAM'],
  ['LATENCY', 'HISTORY', 'command'],
  ['LATENCY', 'DOCTOR'],
  ['MEMORY', 'STATS'],
  ['MEMORY', 'DOCTOR'],
  ['ACL', 'WHOAMI'],
  ['ACL', 'LOG', '100'],
  ['ROLE'],
  ['CLUSTER', 'INFO'],
  ['CLUSTER', 'NODES'],
  ['CLUSTER', 'SHARDS'],
  ['CLUSTER', 'SLOT-STATS', 'SLOTSRANGE', '0', '16383'],
  ['CLUSTER', 'MYID'],
  ['COMMAND', 'INFO', 'MONITOR'],
  ['DBSIZE'],
  ['LASTSAVE'],
  ['TIME'],
  ['MODULE', 'LIST'],
];

const BASE_DENIED: Command[] = [
  ['GET', 'k'],
  ['SET', 'k', 'v'],
  ['SCAN', '0'],
  ['FLUSHALL'],
  ['CLIENT', 'KILL', 'ID', '1'],
  ['CONFIG', 'SET', 'maxmemory', '0'],
  ['SLOWLOG', 'RESET'],
  ['MONITOR'],
  ['ACL', 'LIST'],
];

const ADD_ONS: Record<string, { allowed: Command[]; denied: Command[]; with?: string }> = {
  'Key sampling': {
    allowed: [
      ['SCAN', '0', 'COUNT', '100'],
      ['TYPE', 'k'],
      ['TTL', 'k'],
      ['PTTL', 'k'],
      ['EXISTS', 'k'],
      ['MEMORY', 'USAGE', 'k'],
      ['OBJECT', 'FREQ', 'k'],
      ['OBJECT', 'IDLETIME', 'k'],
      ['STRLEN', 'k'],
      ['LLEN', 'k'],
      ['HLEN', 'k'],
      ['SCARD', 'k'],
      ['ZCARD', 'k'],
      ['XLEN', 'k'],
    ],
    denied: [
      ['GET', 'k'],
      ['HGETALL', 'k'],
      ['UNLINK', 'k'],
    ],
  },
  'AI observability': {
    allowed: [
      ['HGETALL', '__betterdb:caches'],
      ['GET', '__betterdb:heartbeat:faq'],
      ['HGETALL', 'faq:__stats'],
      ['HGETALL', 'faq:__config'],
      ['HGETALL', 'mem:__mem_config'],
      ['ZRANGE', 'faq:__similarity_window', '0', '-1'],
      ['ZRANGEBYSCORE', 'faq:__similarity_window', '0', '+inf'],
      ['HGET', 'faq:__tool_policies', 'search'],
      ['LRANGE', 'faq:__tuning_history', '0', '9'],
    ],
    denied: [
      ['GET', 'faq:entry:1'],
      ['HSET', 'faq:__stats', 'f', 'v'],
    ],
  },
  'ACL auditing': {
    allowed: [
      ['ACL', 'LIST'],
      ['ACL', 'USERS'],
      ['ACL', 'GETUSER', 'default'],
    ],
    denied: [['ACL', 'SETUSER', 'x']],
  },
  'Session capture': {
    allowed: [['MONITOR'], ['ACL', 'GETUSER', 'default']],
    denied: [['GET', 'k']],
  },
  'Vector search': {
    allowed: [
      ['SCAN', '0', 'TYPE', 'hash'],
      ['FT._LIST'],
      ['FT.INFO', 'idx'],
      ['FT.SEARCH', 'idx', '*'],
      ['HGET', 'k', 'f'],
      ['HGETALL', 'k'],
    ],
    denied: [
      ['FT.CREATE', 'idx2', 'SCHEMA', 'f', 'TEXT'],
      ['FT.DROPINDEX', 'idx'],
      ['HSET', 'k', 'f', 'v'],
    ],
  },
  'Session explorer': {
    allowed: [
      ['SCAN', '0', 'MATCH', 'sess:*'],
      ['EXISTS', 'k'],
      ['TYPE', 'k'],
      ['PTTL', 'k'],
      ['MEMORY', 'USAGE', 'k'],
      ['OBJECT', 'IDLETIME', 'k'],
      ['STRLEN', 'k'],
      ['GETRANGE', 'k', '0', '1023'],
      ['LLEN', 'k'],
      ['LRANGE', 'k', '0', '99'],
      ['HLEN', 'k'],
      ['HSCAN', 'k', '0'],
      ['HSTRLEN', 'k', 'f'],
      ['HMGET', 'k', 'f'],
      ['HGETALL', 'k'],
      ['SCARD', 'k'],
      ['SSCAN', 'k', '0'],
      ['SMEMBERS', 'k'],
      ['ZCARD', 'k'],
      ['ZRANGE', 'k', '0', '99'],
      ['XLEN', 'k'],
      ['XRANGE', 'k', '-', '+', 'COUNT', '100'],
    ],
    denied: [['DEL', 'k']],
  },
  'Migration analysis': {
    with: 'Key sampling',
    allowed: [
      ['FUNCTION', 'LIST'],
      ['HRANDFIELD', 'k', '10'],
      ['HEXPIRETIME', 'k', 'FIELDS', '1', 'f'],
      ['ACL', 'USERS'],
    ],
    denied: [['FUNCTION', 'DELETE', 'lib']],
  },
};

function codeBlockAfter(doc: string, marker: string): string {
  const start = doc.indexOf(marker);
  if (start < 0) throw new Error(`"${marker}" not found in minimum-acl.md`);
  const match = /```\n([^`]+?)\n```/.exec(doc.slice(start));
  if (!match) throw new Error(`No code block after "${marker}"`);
  return match[1].trim();
}

function rulesOf(line: string): string[] {
  return line.replace(/^ACL SETUSER betterdb /, '').split(/\s+/);
}

function commandOfRule(rule: string): string | null {
  const match = /^\+([^|@]+)/.exec(rule);
  return match ? match[1].toLowerCase() : null;
}

describe('Minimum ACL page (E2E)', () => {
  const doc = readFileSync(DOC_PATH, 'utf8');
  const baseLine = codeBlockAfter(doc, '## Read-only monitoring user');
  let admin: Valkey;
  let known: Set<string>;

  const setUser = async (rules: string[]) => {
    const supported = rules.filter((r) => {
      const cmd = commandOfRule(r);
      return cmd === null || known.has(cmd);
    });
    await admin.call('ACL', 'SETUSER', USER, ...supported);
  };

  const dryRun = async (cmd: Command): Promise<string> => {
    if (!known.has(cmd[0].toLowerCase())) return 'unsupported';
    return String(await admin.call('ACL', 'DRYRUN', USER, ...cmd));
  };

  const expectAllowed = async (commands: Command[]) => {
    let checked = 0;
    for (const cmd of commands) {
      const result = await dryRun(cmd);
      if (result === 'unsupported') continue;
      checked++;
      expect({ cmd: cmd.join(' '), result }).toEqual({ cmd: cmd.join(' '), result: 'OK' });
    }
    expect(checked).toBeGreaterThan(0);
  };

  const expectDenied = async (commands: Command[]) => {
    let checked = 0;
    for (const cmd of commands) {
      const result = await dryRun(cmd);
      if (result === 'unsupported') continue;
      checked++;
      expect({ cmd: cmd.join(' '), denied: /has no permissions/.test(result) }).toEqual({
        cmd: cmd.join(' '),
        denied: true,
      });
    }
    expect(checked).toBeGreaterThan(0);
  };

  beforeAll(async () => {
    admin = new Valkey({
      host: process.env.TEST_DB_HOST || 'localhost',
      port: parseInt(process.env.TEST_DB_PORT || '6390', 10),
      username: process.env.TEST_DB_USERNAME || 'default',
      password: process.env.TEST_DB_PASSWORD || 'devpassword',
      lazyConnect: true,
    });
    await admin.connect();
    const names = (await admin.call('COMMAND', 'LIST')) as string[];
    known = new Set(names.map((n) => n.toLowerCase()));
  });

  afterAll(async () => {
    await admin.call('ACL', 'DELUSER', USER).catch(() => undefined);
    await admin.quit();
  });

  beforeEach(async () => {
    await admin.call('ACL', 'DELUSER', USER);
  });

  it('allows every command the read-only user is documented to send', async () => {
    await setUser(rulesOf(baseLine));
    await expectAllowed(BASE_ALLOWED);
  });

  it('blocks key access and state changes for the read-only user', async () => {
    await setUser(rulesOf(baseLine));
    await expectDenied(BASE_DENIED);
  });

  it('replaces passwords and selectors on an existing user', async () => {
    await admin.call('ACL', 'SETUSER', USER, 'on', '>old', '~*', '+@all', '(~* +@all)');
    await setUser(rulesOf(baseLine));
    await expectDenied([['SET', 'k', 'v']]);
    const user = (await admin.call('ACL', 'GETUSER', USER)) as unknown[];
    const field = (name: string) => user[user.indexOf(name) + 1] as unknown[];
    expect(field('passwords')).toHaveLength(1);
    expect(field('selectors')).toEqual([]);
  });

  it('matches the "Checking a user" examples', async () => {
    await setUser(rulesOf(baseLine));
    await expectAllowed([['SLOWLOG', 'GET', '10']]);
    await expectDenied([['CLIENT', 'KILL', 'ID', '1']]);
  });

  it('documents every add-on this spec checks', () => {
    for (const name of Object.keys(ADD_ONS)) {
      expect(() => codeBlockAfter(doc, `### ${name}`)).not.toThrow();
    }
  });

  describe.each(Object.entries(ADD_ONS))('%s add-on', (name, { allowed, denied, with: extra }) => {
    beforeEach(async () => {
      const addOns = extra ? [extra, name] : [name];
      await setUser([
        ...rulesOf(baseLine),
        ...addOns.flatMap((n) => rulesOf(codeBlockAfter(doc, `### ${n}`))),
      ]);
    });

    it('allows the commands it enables', async () => {
      await expectAllowed(allowed);
    });

    it('still blocks what it does not name', async () => {
      await expectDenied(denied);
    });
  });
});
