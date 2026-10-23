import Valkey from 'iovalkey';
import calculateSlot from 'cluster-key-slot';
import { readSessionKeys } from '../session-reader';
import { FakeEntry, FakeValkey, fakeDb, masterNode } from './fake-valkey';

jest.mock('iovalkey', () => ({ __esModule: true, default: jest.fn() }));

const ValkeyMock = Valkey as unknown as jest.Mock;
const MB = 1024 * 1024;

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
    expect(client.callsOf('pipeline.getBuffer')).toHaveLength(0);
    expect(client.callsOf('pipeline.getrangeBuffer')[0].args).toEqual(['k', 0, 2 * MB - 1]);
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
    expect(client.pipelineExecs).toBe(6);
    expect(client.directReads).toHaveLength(0);
  });

  it('reads a list over 500 items in windows', async () => {
    const items = Array.from({ length: 1200 }, (_, i) => `m${i}`);
    const client = new FakeValkey(storeOf({ l: { type: 'list', value: items } }));

    const key = await readOne(client, 'l');

    expect(client.callsOf('pipeline.lrangeBuffer').map((c) => c.args.slice(1))).toEqual([[0, 499]]);
    expect(client.callsOf('lrangeBuffer').map((c) => c.args.slice(1))).toEqual([
      [500, 999],
      [1000, 1499],
    ]);
    expect(key.value).toEqual(items);
    expect(key.truncated).toBeFalsy();
  });

  it('stops reading a list at the byte cap', async () => {
    const items = Array.from({ length: 50 }, () => 'y'.repeat(100));
    const client = new FakeValkey(storeOf({ l: { type: 'list', value: items } }));

    const key = await readOne(client, 'l', { byteCap: 1000, listWindow: 20 });

    expect(key.truncated).toBe(true);
    expect((key.value as string[]).length).toBe(10);
    expect(client.callsOf('lrangeBuffer')).toHaveLength(0);
  });

  const fetchedItems = (client: FakeValkey, command: string) =>
    [...client.callsOf(`pipeline.${command}`), ...client.callsOf(command)].reduce((sum, c) => {
      const [, start, stop] = c.args as [string, number, number | string];
      return sum + Number(stop) - start + 1;
    }, 0);

  it('fetches only a few elements past the cap from a list of large items', async () => {
    const items = Array.from({ length: 50 }, () => 'y'.repeat(100_000));
    const client = new FakeValkey(storeOf({ l: { type: 'list', value: items, memory: 5 * MB } }));

    const key = await readOne(client, 'l', { byteCap: 250_000 });

    expect(key.truncated).toBe(true);
    expect((key.value as string[]).length).toBe(2);
    expect(fetchedItems(client, 'lrangeBuffer')).toBeLessThanOrEqual(4);
  });

  it('fetches only a few members past the cap from a sorted set of large members', async () => {
    const value = Array.from({ length: 50 }, (_, i) => ['z'.repeat(100_000) + i, String(i)]).flat();
    const client = new FakeValkey(storeOf({ z: { type: 'zset', value, memory: 5 * MB } }));

    const key = await readOne(client, 'z', { byteCap: 250_000 });

    expect(key.truncated).toBe(true);
    expect((key.value as unknown[]).length).toBe(2);
    expect(fetchedItems(client, 'zrangeBuffer')).toBeLessThanOrEqual(4);
  });

  it('pages a stream of large entries and stops at the cap', async () => {
    const value = Array.from(
      { length: 50 },
      (_, i) => [`${i + 1}-0`, { m: 's'.repeat(100_000) }] as [string, Record<string, string>],
    );
    const client = new FakeValkey(storeOf({ s: { type: 'stream', value, memory: 5 * MB } }));

    const key = await readOne(client, 's', { byteCap: 250_000 });

    expect(key.truncated).toBe(true);
    expect((key.value as unknown[]).length).toBe(2);
    const counts = [...client.callsOf('pipeline.xrangeBuffer'), ...client.callsOf('xrangeBuffer')]
      .map((c) => Number(c.args[4]));
    expect(counts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(4);
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
    expect(client.callsOf('xrangeBuffer').every((c) => !String(c.args[1]).startsWith('('))).toBe(
      true,
    );
  });

  it('reads a hash as a record of strings', async () => {
    const client = new FakeValkey(
      storeOf({ h: { type: 'hash', value: { a: '1', b: '2' }, memory: 50 } }),
    );
    const key = await readOne(client, 'h');
    expect(key.value).toEqual({ a: '1', b: '2' });
    expect(client.callsOf('pipeline.hgetallBuffer')).toHaveLength(1);
  });

  it('reads a hash larger than the cap with a bounded HSCAN', async () => {
    const client = new FakeValkey(
      storeOf({ h: { type: 'hash', value: { a: 'x'.repeat(60), b: 'y'.repeat(60) }, memory: 5000 } }),
    );
    const key = await readOne(client, 'h', { byteCap: 100 });
    expect(client.callsOf('pipeline.hgetallBuffer')).toHaveLength(0);
    expect(client.callsOf('hscanBuffer')).toHaveLength(2);
    expect(key.truncated).toBe(true);
    expect(Object.keys(key.value as object)).toEqual(['a']);
  });

  it('starts HSCAN at one field and sizes later pages from the field average', async () => {
    const value = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [String(i), 'v'.repeat(9)]),
    );
    const client = new FakeValkey(storeOf({ h: { type: 'hash', value, memory: 5000 } }));
    const key = await readOne(client, 'h', { byteCap: 1000, listWindow: 500 });
    expect(client.callsOf('hscanBuffer').map((c) => c.args[3])).toEqual([1, 100]);
    expect(Object.keys(key.value as object)).toHaveLength(10);
    expect(key.truncated).toBeFalsy();
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
    expect(client.callsOf('pipeline.callBuffer')[0].args).toEqual(['JSON.GET', 'j']);
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
    expect(client.callsOf('pipeline.callBuffer')).toHaveLength(0);
    expect(client.callsOf('callBuffer')).toHaveLength(0);
  });

  it('sizes JSON with JSON.DEBUG MEMORY when MEMORY USAGE is unavailable', async () => {
    const client = new FakeValkey(
      storeOf({ j: { type: 'ReJSON-RL', value: '{"a":1}', memory: null, jsonMemory: 40 } }),
    );
    const key = await readOne(client, 'j');
    expect(client.callsOf('pipeline.call')[0].args).toEqual(['JSON.DEBUG', 'MEMORY', 'j']);
    expect(key).toMatchObject({ value: '{"a":1}' });
    expect(key.truncated).toBeFalsy();
  });

  it('does not read JSON when no size is available', async () => {
    const client = new FakeValkey(
      storeOf({ j: { type: 'ReJSON-RL', value: '{"a":1}', memory: null, jsonMemory: null } }),
    );
    const key = await readOne(client, 'j');
    expect(key).toMatchObject({ value: '', truncated: true });
    expect(client.calls.some((c) => c.args[0] === 'JSON.GET')).toBe(false);
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
    expect(result.missingKeys).toBe(1);
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
    expect(result).toMatchObject({ truncated: false, failedNodes: 0, missingKeys: 0 });
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

  it('omits a key answered with MOVED during slot migration', async () => {
    const nodeA = new FakeValkey(
      storeOf({ a: { type: 'string', value: '1' }, b: { type: 'string', value: '2' } }),
    );
    nodeA.movedKeys.add('a');
    const db = clusterOf({ 7001: nodeA }, { 7001: [[0, 16383]] });

    const result = await readSessionKeys(db, ['a', 'b']);

    expect(result.keys.map((k) => k.key)).toEqual(['b']);
    expect(result.missingKeys).toBe(1);
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
    expect(result).toMatchObject({ failedNodes: 1, missingKeys: 1 });
  });
});
