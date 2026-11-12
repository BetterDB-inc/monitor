import Valkey from 'iovalkey';
import calculateSlot from 'cluster-key-slot';
import type { DatabasePort } from '../../common/interfaces/database-port.interface';
import { withPrimaries } from '../primary-nodes';
import { type ReadOptions, readSessionKeysOn } from '../session-reader';
import { FakeEntry, FakeValkey, fakeDb, masterNode } from './fake-valkey';

jest.mock('iovalkey', () => ({ __esModule: true, default: jest.fn() }));

const ValkeyMock = Valkey as unknown as jest.Mock;
const MB = 1024 * 1024;

const readSessionKeys = (db: DatabasePort, keys: string[], options?: ReadOptions) =>
  withPrimaries(db, (primaries) => readSessionKeysOn(primaries, keys, options));

const storeOf = (entries: Record<string, FakeEntry>) => new Map(Object.entries(entries));

const readOne = async (client: FakeValkey, key: string, opts = {}) =>
  (await readSessionKeys(fakeDb(client), [key], opts)).keys[0];

function clusterOf(nodes: Record<number, FakeValkey>, slotsByPort: Record<number, number[][]>) {
  ValkeyMock.mockImplementation((opts: { port: number }) => nodes[opts.port]);
  return fakeDb(new FakeValkey(), {
    nodes: Object.keys(nodes).map((port) =>
      masterNode(port, `10.0.0.1:${port}`, [], slotsByPort[Number(port)]),
    ),
  });
}

describe('readSessionKeys', () => {
  beforeEach(() => ValkeyMock.mockReset());

  it('reports that reads touch keys when no NO-TOUCH reader could be opened', async () => {
    const client = new FakeValkey(storeOf({ k: { type: 'string', value: 'v' } }));
    client.noTouchError = new Error('ERR unknown subcommand');
    const read = await readSessionKeys(fakeDb(client), ['k']);
    expect(read.touchesKeys).toBe(true);
  });

  it('reports that reads leave access times alone through a NO-TOUCH reader', async () => {
    const parent = new FakeValkey();
    parent.duplicateWith = new FakeValkey(storeOf({ k: { type: 'string', value: 'v' } }));
    const read = await readSessionKeys(fakeDb(parent), ['k']);
    expect(read.touchesKeys).toBe(false);
  });

  it('reads a small string whole', async () => {
    const client = new FakeValkey(storeOf({ k: { type: 'string', value: 'hello', pttl: 500 } }));
    const key = await readOne(client, 'k');
    expect(key).toMatchObject({ key: 'k', type: 'string', pttl: 500, value: 'hello' });
    expect(key.truncated).toBeFalsy();
  });

  it('truncates a 3 MB string at a 2 MB cap without reading it whole', async () => {
    const big = 'x'.repeat(3 * MB);
    const client = new FakeValkey(storeOf({ k: { type: 'string', value: big, memory: 3 * MB } }));

    const key = await readOne(client, 'k', { byteCap: 2 * MB });

    expect(key.truncated).toBe(true);
    expect((key.value as string).length).toBeGreaterThanOrEqual(2 * MB - 4);
    expect((key.value as string).length).toBeLessThanOrEqual(2 * MB);
    expect(client.reader.callsOf('pipeline.getBuffer')).toHaveLength(0);
    expect(client.reader.callsOf('pipeline.getrangeBuffer')[0].args).toEqual(['k', 0, 2 * MB - 1]);
  });

  it('keeps a multibyte character split by the cap out of the truncated string', async () => {
    const client = new FakeValkey(storeOf({ k: { type: 'string', value: 'ab€€€' } }));
    const key = await readOne(client, 'k', { byteCap: 6 });
    expect(key).toMatchObject({ value: 'ab€', truncated: true });
  });

  it('flags a binary string and keeps its bytes as base64', async () => {
    const client = new FakeValkey(
      storeOf({ k: { type: 'string', value: Buffer.from([0x80, 0x81, 0xff]) } }),
    );
    const key = await readOne(client, 'k');
    expect(key).toMatchObject({
      value: Buffer.from([0x80, 0x81, 0xff]).toString('base64'),
      binary: true,
    });
  });

  it('wraps binary list elements so they stay distinguishable from text', async () => {
    const client = new FakeValkey(
      storeOf({ k: { type: 'list', value: [Buffer.from('ok'), Buffer.from([0xff])] } }),
    );
    const key = await readOne(client, 'k');
    expect(key.value).toEqual(['ok', { base64: '/w==' }]);
    expect(key.binary).toBeUndefined();
  });

  it('pipelines a session of small string keys in batches', async () => {
    const entries: Record<string, FakeEntry> = {};
    const keys = Array.from({ length: 2500 }, (_, i) => `s:${i}`);
    for (const key of keys) entries[key] = { type: 'string', value: 'v', memory: 50 };
    const client = new FakeValkey(storeOf(entries));

    const result = await readSessionKeys(fakeDb(client), keys, { batch: 1000 });

    expect(result.keys).toHaveLength(2500);
    expect(client.reader.pipelineExecs).toBe(6);
    expect(client.reader.directReads).toHaveLength(0);
  });

  it('reads a list over 500 items in windows', async () => {
    const items = Array.from({ length: 1200 }, (_, i) => `m${i}`);
    const client = new FakeValkey(storeOf({ l: { type: 'list', value: items } }));

    const key = await readOne(client, 'l');

    expect(client.reader.callsOf('lrangeBuffer').map((c) => c.args.slice(1))).toEqual([
      [0, 0],
      [1, 2],
      [3, 6],
      [7, 14],
      [15, 30],
      [31, 62],
      [63, 126],
      [127, 254],
      [255, 510],
      [511, 1010],
      [1011, 1510],
    ]);
    expect(key.value).toEqual(items);
    expect(key.truncated).toBeFalsy();
  });

  it('stops reading a list at the byte cap', async () => {
    const items = Array.from({ length: 50 }, () => 'y'.repeat(100));
    const client = new FakeValkey(storeOf({ l: { type: 'list', value: items } }));

    const key = await readOne(client, 'l', { byteCap: 1000, listWindow: 20 });

    expect(key.truncated).toBe(true);
    expect((key.value as string[]).length).toBe(9);
    expect(client.reader.fetchedBytes).toBeLessThanOrEqual(1000 + 100);
  });

  it('measures small collections over every element and samples large ones', async () => {
    const large: Record<string, string> = {};
    for (let i = 0; i < 200; i++) large[`f${i}`] = 'v';
    const client = new FakeValkey(
      storeOf({
        small: { type: 'hash', value: { a: '1', b: '2' } },
        large: { type: 'hash', value: large },
      }),
    );

    await readSessionKeys(fakeDb(client), ['small', 'large']);

    expect(client.reader.callsOf('pipeline.memory').map((c) => c.args)).toEqual([
      ['USAGE', 'small'],
      ['USAGE', 'large'],
      ['USAGE', 'small', 'SAMPLES', 0],
    ]);
  });

  it('fetches about one cap from a list of large items', async () => {
    const items = Array.from({ length: 500 }, () => 'x'.repeat(64 * 1024));
    const client = new FakeValkey(storeOf({ l: { type: 'list', value: items, memory: 33 * MB } }));

    const key = await readOne(client, 'l', { byteCap: 128 * 1024 });

    expect(key.truncated).toBe(true);
    expect((key.value as string[]).length).toBe(1);
    expect(client.reader.fetchedBytes).toBeLessThanOrEqual(128 * 1024 + 64 * 1024);
  });

  it('fetches about one cap from a list whose large items follow a small one', async () => {
    const items = ['hi', ...Array.from({ length: 20 }, () => 'x'.repeat(512 * 1024))];
    const client = new FakeValkey(storeOf({ l: { type: 'list', value: items, memory: 11 * MB } }));

    const key = await readOne(client, 'l', { byteCap: 2 * MB });

    expect(key.truncated).toBe(true);
    expect((key.value as string[]).length).toBe(4);
    expect(client.reader.fetchedBytes).toBeLessThanOrEqual(2 * MB + 512 * 1024);
  });

  it('fetches about one cap from a sorted set of large members', async () => {
    const flat = Array.from({ length: 300 }, (_, i) => [`${i}`.padEnd(64 * 1024, 'm'), `${i}`]).flat();
    const client = new FakeValkey(storeOf({ z: { type: 'zset', value: flat, memory: 20 * MB } }));

    const key = await readOne(client, 'z', { byteCap: 128 * 1024 });

    expect(key.truncated).toBe(true);
    expect(client.reader.fetchedBytes).toBeLessThanOrEqual(128 * 1024 + 64 * 1024 + 1024);
  });

  it('fetches about one cap from a stream whose large entries follow a small one', async () => {
    const value = [
      ['1-0', { m: 'hi' }],
      ...Array.from({ length: 20 }, (_, i) => [`${i + 2}-0`, { m: 'x'.repeat(512 * 1024) }]),
    ] as Array<[string, Record<string, string>]>;
    const client = new FakeValkey(storeOf({ s: { type: 'stream', value, memory: 11 * MB } }));

    const key = await readOne(client, 's', { byteCap: 2 * MB });

    expect(key.truncated).toBe(true);
    expect(client.reader.fetchedBytes).toBeLessThanOrEqual(2 * MB + 512 * 1024 + 1024);
  });

  it('scans a hash over the cap in windows sized from its unread bytes', async () => {
    const value: Record<string, string> = {};
    for (let i = 0; i < 40; i++) value[`f${i}`] = 'x'.repeat(64 * 1024);
    const client = new FakeValkey(storeOf({ h: { type: 'hash', value, memory: 3 * MB } }));

    const key = await readOne(client, 'h', { byteCap: 256 * 1024 });

    expect(client.reader.callsOf('pipeline.hgetallBuffer')).toHaveLength(0);
    expect(key.truncated).toBe(true);
    expect(client.reader.fetchedBytes).toBeLessThanOrEqual(256 * 1024 + 64 * 1024 + 1024);
  });

  it('grows windows gradually when MEMORY USAGE is unavailable', async () => {
    const items = ['hi', ...Array.from({ length: 20 }, () => 'x'.repeat(512 * 1024))];
    const client = new FakeValkey(storeOf({ l: { type: 'list', value: items, memory: null } }));

    const key = await readOne(client, 'l', { byteCap: 2 * MB });

    expect(key.truncated).toBe(true);
    expect(client.reader.fetchedBytes).toBeLessThanOrEqual(2 * MB + 512 * 1024 + 2);
  });

  it('scans an unmeasured hash from one field and grows by the largest seen', async () => {
    const value: Record<string, string> = {};
    for (let i = 0; i < 40; i++) value[`f${i}`] = 'x'.repeat(64 * 1024);
    const client = new FakeValkey(storeOf({ h: { type: 'hash', value, memory: null } }));

    const key = await readOne(client, 'h', { byteCap: 256 * 1024 });

    expect(client.reader.callsOf('hscanBuffer')[0].args[3]).toBe(1);
    expect(key.truncated).toBe(true);
    expect(client.reader.fetchedBytes).toBeLessThanOrEqual(256 * 1024 + 64 * 1024 + 1024);
  });

  it.each(['list', 'zset', 'stream'])(
    'fetches about one cap from a %s whose large elements precede many small ones',
    async (type) => {
      const big = Array.from({ length: 100 }, (_, i) => `${i}`.padEnd(512 * 1024, 'b'));
      const small = Array.from({ length: 50_000 }, (_, i) => `s${i}`);
      const members = ['a', ...big, ...small];
      const value =
        type === 'list'
          ? members
          : type === 'zset'
            ? members.flatMap((m, i) => [m, `${i}`])
            : members.map((m, i) => [`${i + 1}-0`, { m }] as [string, Record<string, string>]);
      const memory = 100 * 512 * 1024 + 50_000 * 8;
      const client = new FakeValkey(storeOf({ k: { type, value, memory } }));

      const key = await readOne(client, 'k', { byteCap: 2 * MB });

      expect(key.truncated).toBe(true);
      expect(client.reader.fetchedBytes).toBeLessThanOrEqual(2 * MB + 512 * 1024 + 1024);
    },
  );

  it('bounds an unmeasured list whose large elements follow many small ones', async () => {
    const items = [...Array.from({ length: 31 }, () => 't'), ...Array.from({ length: 32 }, () => 'x'.repeat(MB))];
    const client = new FakeValkey(storeOf({ l: { type: 'list', value: items, memory: null } }));

    const key = await readOne(client, 'l', { byteCap: 2 * MB });

    expect(key.truncated).toBe(true);
    expect(client.reader.fetchedBytes).toBeLessThanOrEqual(2 * MB + 4 * MB);
  });

  it('does not trust MEMORY USAGE far below the real size of a list', async () => {
    const items = Array.from({ length: 500 }, () => 'x'.repeat(64 * 1024));
    const client = new FakeValkey(storeOf({ l: { type: 'list', value: items, memory: 533 * 1024 } }));

    const key = await readOne(client, 'l', { byteCap: 2 * MB });

    expect(key.truncated).toBe(true);
    expect(client.reader.fetchedBytes).toBeLessThanOrEqual(2 * MB + 64 * 1024 + 1024);
  });

  it('measures a list exactly when large elements follow many small ones', async () => {
    const items = [
      ...Array.from({ length: 5000 }, () => 'x'.repeat(300)),
      ...Array.from({ length: 20 }, () => 'y'.repeat(MB)),
    ];
    const client = new FakeValkey(
      storeOf({ l: { type: 'list', value: items, memory: 22 * MB, sampledMemory: 2 * MB } }),
    );

    const key = await readOne(client, 'l', { byteCap: 2 * MB });

    expect(key.truncated).toBe(true);
    expect(client.reader.fetchedBytes).toBeLessThanOrEqual(2 * MB + MB);
  });

  it('skips a list whose elements are each larger than the byte cap', async () => {
    const client = new FakeValkey(
      storeOf({ l: { type: 'list', value: ['y'.repeat(3 * MB)], memory: 3 * MB + 64 } }),
    );

    const key = await readOne(client, 'l', { byteCap: 2 * MB });

    expect(key).toMatchObject({ value: [], truncated: true });
    expect(client.reader.callsOf('lrangeBuffer')).toHaveLength(0);
  });

  it.each([
    ['zset', ['y'.repeat(3 * MB), '1'], 'zrangeBuffer'],
    ['stream', [['1-0', { f: 'y'.repeat(3 * MB) }]], 'xrangeBuffer'],
    ['set', ['y'.repeat(3 * MB)], 'sscanBuffer'],
  ] as const)(
    'skips a %s whose elements are each larger than the byte cap',
    async (type, value, read) => {
      const entry = { type, value: value as unknown as FakeEntry['value'], memory: 3 * MB + 64 };
      const client = new FakeValkey(storeOf({ k: entry }));

      const key = await readOne(client, 'k', { byteCap: 2 * MB });

      expect(key).toMatchObject({ value: [], truncated: true });
      expect(client.reader.callsOf(read)).toHaveLength(0);
      expect(client.reader.fetchedBytes).toBeLessThan(MB);
    },
  );

  it('probes hash field sizes and leaves a field over the cap unread', async () => {
    const value: Record<string, string> = {};
    for (let i = 0; i < 200; i++) value[`f${i}`] = 'x';
    value.huge = 'y'.repeat(3 * MB);
    const client = new FakeValkey(storeOf({ h: { type: 'hash', value, memory: 3 * MB + 4096 } }));

    const key = await readOne(client, 'h', { byteCap: 2 * MB });

    expect(key.truncated).toBe(true);
    expect(key.value).not.toHaveProperty('huge');
    expect(Object.keys(key.value as object).length).toBe(200);
    expect(client.reader.fetchedBytes).toBeLessThan(MB);
    expect(client.reader.callsOf('hscanBuffer')[0].args).toContain('NOVALUES');
  });

  it('keeps smaller hash fields scanned after one over the cap', async () => {
    const value: Record<string, string> = { huge: 'y'.repeat(3 * MB) };
    for (let i = 0; i < 10; i++) value[`f${i}`] = 'x';
    const client = new FakeValkey(storeOf({ h: { type: 'hash', value, memory: 3 * MB + 4096 } }));

    const key = await readOne(client, 'h', { byteCap: 2 * MB });

    expect(key.truncated).toBe(true);
    expect(Object.keys(key.value as object)).toHaveLength(10);
    expect(client.reader.fetchedBytes).toBeLessThan(MB);
  });

  it('reads the small fields of a hash whose average field is over the cap', async () => {
    const value = { huge: 'y'.repeat(6 * MB), small: 'x' };
    const client = new FakeValkey(storeOf({ h: { type: 'hash', value, memory: 6 * MB } }));

    const key = await readOne(client, 'h', { byteCap: 2 * MB });

    expect(key).toMatchObject({ value: { small: 'x' }, truncated: true });
    expect(client.reader.fetchedBytes).toBeLessThan(MB);
  });

  it('skips a hash whose average field is over the cap when the server has no NOVALUES', async () => {
    const value = { huge: 'y'.repeat(6 * MB), small: 'x' };
    const client = new FakeValkey(storeOf({ h: { type: 'hash', value, memory: 6 * MB } }));
    client.noValues = false;

    const key = await readOne(client, 'h', { byteCap: 2 * MB });

    expect(key).toMatchObject({ value: {}, truncated: true });
    expect(client.reader.fetchedBytes).toBeLessThan(MB);
  });

  it('leaves hash fields unread when their size probe fails', async () => {
    const value = { a: 'y'.repeat(3 * MB) };
    const client = new FakeValkey(storeOf({ h: { type: 'hash', value, memory: 3 * MB } }));
    client.failHstrlen = true;

    const key = await readOne(client, 'h', { byteCap: 2 * MB });

    expect(key).toMatchObject({ value: {}, truncated: true });
    expect(client.reader.callsOf('hmgetBuffer')).toHaveLength(0);
  });

  it('reads hash fields with HSCAN when the server has no NOVALUES', async () => {
    const value: Record<string, string> = {};
    for (let i = 0; i < 200; i++) value[`f${i}`] = 'x';
    const client = new FakeValkey(storeOf({ h: { type: 'hash', value, memory: 3 * MB } }));
    client.noValues = false;

    const key = await readOne(client, 'h', { byteCap: 2 * MB });

    expect(Object.keys(key.value as object).length).toBe(200);
    expect(key.truncated).toBeFalsy();
  });

  it('counts per-element wire overhead against the cap', async () => {
    const items = Array.from({ length: 100_000 }, () => 'x');
    const client = new FakeValkey(storeOf({ l: { type: 'list', value: items } }));

    const key = await readOne(client, 'l', { byteCap: 100_000 });

    expect(key.truncated).toBe(true);
    expect((key.value as string[]).length).toBe(Math.floor(100_000 / 7));
  });

  it('reads a whole stream of small entries across pages', async () => {
    const value = Array.from(
      { length: 1200 },
      (_, i) => [`${i + 1}-0`, { m: `e${i}` }] as [string, Record<string, string>],
    );
    const client = new FakeValkey(storeOf({ s: { type: 'stream', value } }));

    const key = await readOne(client, 's');

    expect(key.truncated).toBeFalsy();
    expect((key.value as unknown[]).length).toBe(1200);
    expect((key.value as Array<[string, unknown]>)[1199]).toEqual(['1200-0', { m: 'e1199' }]);
  });

  it('pages a stream with ids older servers accept, across a sequence rollover', async () => {
    const value = Array.from(
      { length: 1200 },
      (_, i) =>
        [i % 2 === 0 ? `${i + 1}-18446744073709551615` : `${i}-0`, { m: `e${i}` }] as [
          string,
          Record<string, string>,
        ],
    ).sort(([a], [b]) => {
      const [am, as] = a.split('-').map(BigInt);
      const [bm, bs] = b.split('-').map(BigInt);
      return am === bm ? Number(as - bs) : Number(am - bm);
    });
    const client = new FakeValkey(storeOf({ s: { type: 'stream', value } }));

    const key = await readOne(client, 's');

    expect((key.value as unknown[]).length).toBe(1200);
    expect(client.reader.callsOf('xrangeBuffer').every((c) => !String(c.args[1]).startsWith('('))).toBe(
      true,
    );
  });

  it('stops paging a stream at the byte cap', async () => {
    const value = Array.from(
      { length: 1200 },
      (_, i) => [`${i + 1}-0`, { m: 'x'.repeat(1000) }] as [string, Record<string, string>],
    );
    const client = new FakeValkey(storeOf({ s: { type: 'stream', value } }));

    const key = await readOne(client, 's', { byteCap: 600_000 });

    expect(key.truncated).toBe(true);
    expect((key.value as unknown[]).length).toBeLessThan(1200);
    expect(client.reader.fetchedBytes).toBeLessThanOrEqual(600_000 + 2_000);
  });

  it('reads a hash as a record of strings', async () => {
    const client = new FakeValkey(
      storeOf({ h: { type: 'hash', value: { a: '1', b: '2' }, memory: 50 } }),
    );
    const key = await readOne(client, 'h');
    expect(key.value).toEqual({ a: '1', b: '2' });
    expect(client.reader.callsOf('pipeline.hgetallBuffer')).toHaveLength(1);
  });

  it('reads a hash larger than the cap with a bounded HSCAN', async () => {
    const client = new FakeValkey(
      storeOf({
        h: { type: 'hash', value: { a: 'x'.repeat(60), b: 'y'.repeat(60) }, memory: 150 },
      }),
    );
    const key = await readOne(client, 'h', { byteCap: 100 });
    expect(client.reader.callsOf('pipeline.hgetallBuffer')).toHaveLength(0);
    expect(client.reader.callsOf('hscanBuffer').map((c) => c.args[3])).toEqual([1, 1]);
    expect(key.truncated).toBe(true);
    expect(Object.keys(key.value as object)).toEqual(['a']);
  });

  it('reads a set as its members', async () => {
    const client = new FakeValkey(storeOf({ s: { type: 'set', value: ['a', 'b'], memory: 50 } }));

    const key = await readOne(client, 's');

    expect(key.value).toEqual(['a', 'b']);
    expect(key.truncated).toBeFalsy();
  });

  it('scans a set over the cap up to about one cap', async () => {
    const members = Array.from({ length: 40 }, (_, i) => `${i}`.padEnd(64 * 1024, 'x'));
    const client = new FakeValkey(storeOf({ s: { type: 'set', value: members, memory: 3 * MB } }));

    const key = await readOne(client, 's', { byteCap: 256 * 1024 });

    expect(client.reader.callsOf('pipeline.smembersBuffer')).toHaveLength(0);
    expect(key.truncated).toBe(true);
    expect(client.reader.fetchedBytes).toBeLessThanOrEqual(256 * 1024 + 64 * 1024 + 1024);
  });

  it('marks a module type it cannot read as truncated', async () => {
    const client = new FakeValkey(storeOf({ b: { type: 'MBbloom--', memory: 50 } }));

    const key = await readOne(client, 'b');

    expect(key).toMatchObject({ type: 'MBbloom--', value: null, truncated: true });
  });

  it('reads a sorted set as member and score pairs', async () => {
    const client = new FakeValkey(storeOf({ z: { type: 'zset', value: ['m1', '1', 'm2', '2.5'] } }));
    const key = await readOne(client, 'z');
    expect(key.value).toEqual([
      ['m1', 1],
      ['m2', 2.5],
    ]);
  });

  it('returns ReJSON-RL values as the raw JSON.GET string', async () => {
    const client = new FakeValkey(storeOf({ j: { type: 'ReJSON-RL', value: '{"a":[1,2]}' } }));
    const key = await readOne(client, 'j');
    expect(key.value).toBe('{"a":[1,2]}');
    expect(client.reader.callsOf('callBuffer')[0].args).toEqual(['JSON.GET', 'j']);
  });

  it('applies the byte cap to JSON values', async () => {
    const doc = JSON.stringify({ text: 'z'.repeat(500) });
    const client = new FakeValkey(storeOf({ j: { type: 'ReJSON-RL', value: doc, memory: 300 } }));
    const key = await readOne(client, 'j', { byteCap: 100 });
    expect(key.truncated).toBe(true);
    expect((key.value as string).length).toBe(100);
  });

  it('does not fetch a JSON document far beyond the cap', async () => {
    const client = new FakeValkey(
      storeOf({ j: { type: 'ReJSON-RL', value: '{}', memory: 100 * MB } }),
    );
    const key = await readOne(client, 'j', { byteCap: MB });
    expect(key).toMatchObject({ value: '', truncated: true });
    expect(client.reader.callsOf('pipeline.callBuffer')).toHaveLength(0);
    expect(client.reader.callsOf('callBuffer')).toHaveLength(0);
  });

  it('reserves the full fetch for JSON documents read whole above the cap', async () => {
    const doc = JSON.stringify({ v: 'x'.repeat(8 * MB) });
    const entries = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [
        `j${i}`,
        { type: 'ReJSON-RL', value: doc, memory: 8 * MB },
      ]),
    );
    const client = new FakeValkey(storeOf(entries));

    await readSessionKeys(fakeDb(client), Object.keys(entries), {
      byteCap: 2 * MB,
      totalByteCap: 32 * MB,
    });

    expect(client.reader.fetchedBytes).toBeLessThanOrEqual(32 * MB + 8 * MB + MB);
  });

  it('reads JSON one document at a time against the fetched bytes', async () => {
    const doc = JSON.stringify({ v: '\u0001'.repeat(MB) });
    const entries = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`j${i}`, { type: 'ReJSON-RL', value: doc, memory: MB }]),
    );
    const client = new FakeValkey(storeOf(entries));

    const result = await readSessionKeys(fakeDb(client), Object.keys(entries), {
      byteCap: 2 * MB,
      totalByteCap: 8 * MB,
    });

    expect(result.truncated).toBe(true);
    expect(client.reader.callsOf('pipeline.callBuffer')).toHaveLength(0);
    expect(client.reader.fetchedBytes).toBeLessThanOrEqual(8 * MB + doc.length + MB);
  });

  it('measures JSON exactly before trusting a sampled size', async () => {
    const client = new FakeValkey(
      storeOf({ j: { type: 'ReJSON-RL', value: '{}', memory: 100 * MB, sampledMemory: 100 } }),
    );
    const key = await readOne(client, 'j', { byteCap: MB });
    expect(key).toMatchObject({ value: '', truncated: true });
    expect(client.reader.callsOf('pipeline.callBuffer')).toHaveLength(0);
    expect(client.reader.callsOf('callBuffer')).toHaveLength(0);
  });

  it('sizes JSON with JSON.DEBUG MEMORY when MEMORY USAGE is unavailable', async () => {
    const client = new FakeValkey(
      storeOf({ j: { type: 'ReJSON-RL', value: '{"a":1}', memory: null, jsonMemory: 40 } }),
    );
    const key = await readOne(client, 'j');
    expect(client.reader.callsOf('pipeline.call')[0].args).toEqual(['JSON.DEBUG', 'MEMORY', 'j']);
    expect(key).toMatchObject({ value: '{"a":1}' });
    expect(key.truncated).toBeFalsy();
  });

  it('does not read JSON when no size is available', async () => {
    const client = new FakeValkey(
      storeOf({ j: { type: 'ReJSON-RL', value: '{"a":1}', memory: null, jsonMemory: null } }),
    );
    const key = await readOne(client, 'j');
    expect(key).toMatchObject({ value: '', truncated: true });
    expect(client.reader.calls.some((c) => c.args[0] === 'JSON.GET')).toBe(false);
  });

  it('omits a missing key and counts it as missing', async () => {
    const client = new FakeValkey(storeOf({ k: { type: 'string', value: 'v' } }));
    const result = await readSessionKeys(fakeDb(client), ['gone', 'k']);
    expect(result.keys.map((k) => k.key)).toEqual(['k']);
    expect(result.missingKeys).toBe(1);
  });

  it('omits a key whose read fails without failing the request', async () => {
    const client = new FakeValkey(
      storeOf({ k1: { type: 'string', value: 'a' }, k2: { type: 'string', value: 'b' } }),
    );
    client.failKeys.set('k1', 'WRONGTYPE Operation against a key holding the wrong kind of value');

    const result = await readSessionKeys(fakeDb(client), ['k1', 'k2']);

    expect(result.keys.map((k) => k.key)).toEqual(['k2']);
    expect(result).toMatchObject({ missingKeys: 0, erroredKeys: 1 });
  });

  it('records memory usage as bytes', async () => {
    const client = new FakeValkey(storeOf({ k: { type: 'string', value: 'v', memory: 72 } }));
    const key = await readOne(client, 'k');
    expect(key.bytes).toBe(72);
  });

  it('stops at the total byte budget and flags truncation', async () => {
    const entries: Record<string, FakeEntry> = {};
    const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
    for (const key of keys) entries[key] = { type: 'string', value: 'x'.repeat(100), memory: 100 };
    const client = new FakeValkey(storeOf(entries));

    const result = await readSessionKeys(fakeDb(client), keys, { totalByteCap: 350 });

    expect(result.truncated).toBe(true);
    expect(result.keys.map((k) => k.key)).toEqual(['k0', 'k1', 'k2', 'k3']);
    expect(result.keys[2].truncated).toBeFalsy();
    expect(result.keys[3]).toMatchObject({ value: 'x'.repeat(50), truncated: true });
  });

  it('charges the total budget for oversize elements it fetched and dropped', async () => {
    const huge = 'h'.repeat(6 * MB);
    const entries: Record<string, FakeEntry> = {};
    const keys = Array.from({ length: 20 }, (_, i) => `l${i}`);
    for (const key of keys) {
      entries[key] = { type: 'list', value: [huge, 't', 't', 't'], memory: 6 * MB };
    }
    const client = new FakeValkey(storeOf(entries));

    const result = await readSessionKeys(fakeDb(client), keys);

    expect(result.truncated).toBe(true);
    expect(client.reader.fetchedBytes).toBeLessThanOrEqual(32 * MB + 6 * MB);
  });

  it('reads a key larger than the remaining budget up to the budget', async () => {
    const client = new FakeValkey(
      storeOf({
        big: { type: 'string', value: 'b'.repeat(500), memory: 500 },
        small: { type: 'string', value: 's', memory: 1 },
      }),
    );

    const result = await readSessionKeys(fakeDb(client), ['big', 'small'], { totalByteCap: 200 });

    expect(result.truncated).toBe(true);
    expect(result.keys).toEqual([
      expect.objectContaining({ key: 'big', value: 'b'.repeat(200), truncated: true }),
    ]);
  });

  it('is not truncated when everything fits the budget', async () => {
    const client = new FakeValkey(storeOf({ k: { type: 'string', value: 'v' } }));
    const result = await readSessionKeys(fakeDb(client), ['k']);
    expect(result).toMatchObject({ truncated: false, failed: new Set(), missingKeys: 0 });
  });

  it('routes each key to the primary that owns its slot', async () => {
    const nodeA = new FakeValkey(storeOf({ a: { type: 'string', value: 'from-a' } }));
    const nodeB = new FakeValkey(storeOf({ b: { type: 'string', value: 'from-b' } }));
    const db = clusterOf(
      { 7001: nodeA, 7002: nodeB },
      { 7001: [[calculateSlot('a'), calculateSlot('a')]], 7002: [[calculateSlot('b'), calculateSlot('b')]] },
    );

    const result = await readSessionKeys(db, ['a', 'b']);

    expect(result.keys.map((k) => [k.key, k.value])).toEqual([
      ['a', 'from-a'],
      ['b', 'from-b'],
    ]);
    expect(nodeA.callsOf('pipeline.type').map((c) => c.args[0])).toEqual(['a']);
    expect(nodeB.callsOf('pipeline.type').map((c) => c.args[0])).toEqual(['b']);
    expect(nodeA.disconnected && nodeB.disconnected).toBe(true);
  });

  it('reports a key answered with MOVED as a node issue, not a missing key', async () => {
    const nodeA = new FakeValkey(
      storeOf({ a: { type: 'string', value: '1' }, b: { type: 'string', value: '2' } }),
    );
    nodeA.movedKeys.add('a');
    const db = clusterOf({ 7001: nodeA }, { 7001: [[0, 16383]] });

    const result = await readSessionKeys(db, ['a', 'b']);

    expect(result.keys.map((k) => k.key)).toEqual(['b']);
    expect(result.missingKeys).toBe(0);
    expect(result.failed.size).toBe(1);
  });

  it('reports a key that turns MOVED while its value is read as a node issue', async () => {
    const nodeA = new FakeValkey(
      storeOf({ a: { type: 'list', value: ['1'] }, b: { type: 'string', value: '2' } }),
    );
    (nodeA as unknown as Record<string, unknown>).lrangeBuffer = async () => {
      throw new Error('MOVED 1 10.0.0.9:7000');
    };
    const db = clusterOf({ 7001: nodeA }, { 7001: [[0, 16383]] });

    const result = await readSessionKeys(db, ['a', 'b']);

    expect(result.missingKeys).toBe(0);
    expect(result.failed.size).toBe(1);
  });

  it('measures every key but reads only the selected ones', async () => {
    const client = new FakeValkey(
      storeOf({
        a: { type: 'string', value: 'read', memory: 300, pttl: 9000 },
        b: { type: 'string', value: 'skipped', memory: 200, pttl: 4000 },
        c: { type: 'string', value: 'skipped', memory: 50, pttl: -1 },
      }),
    );

    const result = await readSessionKeys(fakeDb(client), ['a', 'b', 'c'], { selected: ['a'] });

    expect(result.keys.map((k) => k.key)).toEqual(['a']);
    expect(client.reader.callsOf('pipeline.getrangeBuffer').map((c) => c.args[0])).toEqual(['a']);
    expect(result.totals).toEqual({ memoryBytes: 550, unmeasuredKeys: 0, goneKeys: 0, ttlMs: 4000 });
  });

  it('counts keys it could not measure without failing the read', async () => {
    const client = new FakeValkey(
      storeOf({
        a: { type: 'string', value: '1', memory: 300 },
        b: { type: 'string', value: '2', memory: null },
      }),
    );

    const result = await readSessionKeys(fakeDb(client), ['a', 'b', 'gone', 'skipped-gone'], {
      selected: ['a', 'b', 'gone'],
    });

    expect(result.totals).toMatchObject({ memoryBytes: 300, unmeasuredKeys: 2, goneKeys: 1 });
    expect(result.missingKeys).toBe(1);
  });

  it('keeps a route readable when measuring its keys fails', async () => {
    const client = new FakeValkey(
      storeOf({
        l: { type: 'list', value: ['a', 'b'], memory: 90, pttl: 7000 },
        s: { type: 'string', value: 'v', memory: 40, pttl: 9000 },
      }),
    );
    client.failPipelinesWith = new Set(['llen']);

    const result = await readSessionKeys(fakeDb(client), ['l', 's']);

    expect(result.keys.map((k) => k.key)).toEqual(['s']);
    expect(result.failed.size).toBe(0);
    expect(result).toMatchObject({ missingKeys: 0, erroredKeys: 1 });
    expect(result.totals).toMatchObject({ memoryBytes: 130, unmeasuredKeys: 0, ttlMs: 7000 });
  });

  it('totals the sampled memory the session list reports, not the exact memory used for reading', async () => {
    const client = new FakeValkey(
      storeOf({
        l: { type: 'list', value: ['a', 'b'], memory: 90, sampledMemory: 80 },
        j: { type: 'ReJSON-RL', value: '{}', memory: 70, sampledMemory: 50 },
        s: { type: 'string', value: 'v', memory: 40 },
      }),
    );

    const result = await readSessionKeys(fakeDb(client), ['l', 'j', 's']);

    expect(result.totals).toMatchObject({ memoryBytes: 170, unmeasuredKeys: 0 });
    expect(result.keys.find((k) => k.key === 'l')?.bytes).toBe(90);
  });

  it('keeps the sampled memory and lengths when the exact memory pipeline fails', async () => {
    const client = new FakeValkey(
      storeOf({
        l: { type: 'list', value: ['a', 'b'], memory: 90, sampledMemory: 80, pttl: 7000 },
        s: { type: 'string', value: 'v', memory: 40, pttl: 9000 },
      }),
    );
    client.failExactMemory = true;

    const result = await readSessionKeys(fakeDb(client), ['l', 's']);

    expect(result.keys.map((k) => k.key)).toEqual(['l', 's']);
    expect(result.keys[0].value).toEqual(['a', 'b']);
    expect(result).toMatchObject({ missingKeys: 0, erroredKeys: 0 });
    expect(result.totals).toMatchObject({ memoryBytes: 120, unmeasuredKeys: 0 });
  });

  it('counts a key whose TYPE reply failed as unmeasured, not gone', async () => {
    const client = new FakeValkey(
      storeOf({
        a: { type: 'string', value: '1', memory: 300 },
        broken: { type: 'string', value: '2', memory: 40 },
        'broken-selected': { type: 'string', value: '3', memory: 40 },
      }),
    );
    client.failTypeKeys = new Set(['broken', 'broken-selected']);

    const result = await readSessionKeys(fakeDb(client), ['a', 'broken', 'broken-selected', 'gone'], {
      selected: ['a', 'broken-selected'],
    });

    expect(result.keys.map((k) => k.key)).toEqual(['a']);
    expect(result.totals).toMatchObject({ memoryBytes: 300, unmeasuredKeys: 2, goneKeys: 1 });
    expect(result).toMatchObject({ missingKeys: 0, erroredKeys: 1 });
  });

  it('still measures the keys left unread once the byte budget is spent', async () => {
    const nodeA = new FakeValkey(storeOf({ a: { type: 'string', value: 'x'.repeat(100), memory: 100 } }));
    const nodeB = new FakeValkey(storeOf({ b: { type: 'string', value: 'y'.repeat(100), memory: 80 } }));
    const db = clusterOf(
      { 7001: nodeA, 7002: nodeB },
      { 7001: [[calculateSlot('a'), calculateSlot('a')]], 7002: [[calculateSlot('b'), calculateSlot('b')]] },
    );

    const result = await readSessionKeys(db, ['a', 'b'], { totalByteCap: 100 });

    expect(result.truncated).toBe(true);
    expect(result.keys.map((k) => k.key)).toEqual(['a']);
    expect(result.totals).toMatchObject({ memoryBytes: 180, unmeasuredKeys: 0 });
  });

  it('counts the keys of an unreachable primary as unmeasured', async () => {
    const nodeA = new FakeValkey(storeOf({ a: { type: 'string', value: '1', memory: 10 } }));
    const nodeB = new FakeValkey(storeOf({ b: { type: 'string', value: '2' } }));
    nodeB.connectError = new Error('ECONNREFUSED');
    const db = clusterOf(
      { 7001: nodeA, 7002: nodeB },
      { 7001: [[calculateSlot('a'), calculateSlot('a')]], 7002: [[calculateSlot('b'), calculateSlot('b')]] },
    );

    const result = await readSessionKeys(db, ['a', 'b'], { selected: ['a'] });

    expect(result.totals).toMatchObject({ memoryBytes: 10, unmeasuredKeys: 1 });
    expect(result.missingKeys).toBe(0);
  });

  it('does not report a node as failed when it holds only skipped keys', async () => {
    const nodeA = new FakeValkey(storeOf({ a: { type: 'string', value: '1', memory: 10 } }));
    const nodeB = new FakeValkey(storeOf({ b: { type: 'string', value: '2' } }));
    nodeB.pipeline = () => {
      throw new Error('ETIMEDOUT');
    };
    const db = clusterOf(
      { 7001: nodeA, 7002: nodeB },
      { 7001: [[calculateSlot('a'), calculateSlot('a')]], 7002: [[calculateSlot('b'), calculateSlot('b')]] },
    );

    const result = await readSessionKeys(db, ['a', 'b'], { selected: ['a'] });

    expect(result.keys.map((k) => k.key)).toEqual(['a']);
    expect(result.failed.size).toBe(0);
    expect(result.missingKeys).toBe(0);
    expect(result.totals).toMatchObject({ memoryBytes: 10, unmeasuredKeys: 1 });
  });

  it('reports a node as failed when it holds a selected key', async () => {
    const nodeA = new FakeValkey(storeOf({ a: { type: 'string', value: '1', memory: 10 } }));
    const nodeB = new FakeValkey(storeOf({ b: { type: 'string', value: '2' } }));
    nodeB.pipeline = () => {
      throw new Error('ETIMEDOUT');
    };
    const db = clusterOf(
      { 7001: nodeA, 7002: nodeB },
      { 7001: [[calculateSlot('a'), calculateSlot('a')]], 7002: [[calculateSlot('b'), calculateSlot('b')]] },
    );

    const result = await readSessionKeys(db, ['a', 'b'], { selected: ['a', 'b'] });

    expect(result.failed.size).toBe(1);
  });

  it('reports keys owned by an unreachable primary', async () => {
    const nodeA = new FakeValkey(storeOf({ a: { type: 'string', value: '1' } }));
    const nodeB = new FakeValkey(storeOf({ b: { type: 'string', value: '2' } }));
    nodeB.connectError = new Error('ECONNREFUSED');
    const db = clusterOf(
      { 7001: nodeA, 7002: nodeB },
      { 7001: [[calculateSlot('a'), calculateSlot('a')]], 7002: [[calculateSlot('b'), calculateSlot('b')]] },
    );

    const result = await readSessionKeys(db, ['a', 'b']);

    expect(result.keys.map((k) => k.key)).toEqual(['a']);
    expect(result.failed.size).toBe(1);
    expect(result.missingKeys).toBe(0);
  });

  it('does not count an unreachable primary that owns none of the keys', async () => {
    const nodeA = new FakeValkey(storeOf({ a: { type: 'string', value: '1' } }));
    const nodeB = new FakeValkey();
    nodeB.connectError = new Error('ECONNREFUSED');
    const db = clusterOf(
      { 7001: nodeA, 7002: nodeB },
      {
        7001: [
          [calculateSlot('a'), calculateSlot('a')],
          [calculateSlot('gone'), calculateSlot('gone')],
        ],
        7002: [[calculateSlot('b'), calculateSlot('b')]],
      },
    );

    const result = await readSessionKeys(db, ['a', 'gone']);

    expect(result.keys.map((k) => k.key)).toEqual(['a']);
    expect(result.failed.size).toBe(0);
    expect(result.missingKeys).toBe(1);
  });

  it('reports a key whose slot no primary owns as a failure, not a missing key', async () => {
    const nodeA = new FakeValkey(storeOf({ a: { type: 'string', value: '1' } }));
    const db = clusterOf({ 7001: nodeA }, { 7001: [[calculateSlot('a'), calculateSlot('a')]] });

    const result = await readSessionKeys(db, ['a', 'gone']);

    expect(result.keys.map((k) => k.key)).toEqual(['a']);
    expect(result.failed.size).toBe(1);
    expect(result.missingKeys).toBe(0);
  });
});
