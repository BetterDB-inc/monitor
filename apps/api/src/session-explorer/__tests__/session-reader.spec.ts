import Valkey from 'iovalkey';
import { readSessionKeys } from '../session-reader';
import { FakeEntry, FakeValkey, fakeDb, masterNode } from './fake-valkey';

jest.mock('iovalkey', () => ({ __esModule: true, default: jest.fn() }));

const ValkeyMock = Valkey as unknown as jest.Mock;
const MB = 1024 * 1024;

const storeOf = (entries: Record<string, FakeEntry>) => new Map(Object.entries(entries));

describe('readSessionKeys', () => {
  beforeEach(() => ValkeyMock.mockReset());

  it('reads a small string whole', async () => {
    const client = new FakeValkey(storeOf({ k: { type: 'string', value: 'hello', pttl: 500 } }));
    const [key] = await readSessionKeys(fakeDb(client), ['k']);
    expect(key).toMatchObject({ key: 'k', type: 'string', pttl: 500, value: 'hello' });
    expect(key.truncated).toBeFalsy();
    expect(client.callsOf('getBuffer')).toHaveLength(1);
  });

  it('truncates a 3 MB string at a 2 MB cap without reading it whole', async () => {
    const big = 'x'.repeat(3 * MB);
    const client = new FakeValkey(storeOf({ k: { type: 'string', value: big, memory: 3 * MB } }));

    const [key] = await readSessionKeys(fakeDb(client), ['k'], { byteCap: 2 * MB });

    expect(key.truncated).toBe(true);
    expect((key.value as string).length).toBe(2 * MB);
    expect(client.callsOf('getBuffer')).toHaveLength(0);
    expect(client.callsOf('getrangeBuffer')[0].args).toEqual(['k', 0, 2 * MB]);
  });

  it('falls back to base64 for a binary string', async () => {
    const client = new FakeValkey(
      storeOf({ k: { type: 'string', value: Buffer.from([0x80, 0x81, 0xff]) } }),
    );
    const [key] = await readSessionKeys(fakeDb(client), ['k']);
    expect(key.value).toEqual({ base64: Buffer.from([0x80, 0x81, 0xff]).toString('base64') });
  });

  it('reads a list over 500 items in windows', async () => {
    const items = Array.from({ length: 1200 }, (_, i) => `m${i}`);
    const client = new FakeValkey(storeOf({ l: { type: 'list', value: items } }));

    const [key] = await readSessionKeys(fakeDb(client), ['l']);

    expect(client.callsOf('lrangeBuffer').map((c) => c.args.slice(1))).toEqual([
      [0, 499],
      [500, 999],
      [1000, 1499],
    ]);
    expect(key.value).toEqual(items);
    expect(key.truncated).toBeFalsy();
  });

  it('stops reading a list at the byte cap', async () => {
    const items = Array.from({ length: 50 }, () => 'y'.repeat(100));
    const client = new FakeValkey(storeOf({ l: { type: 'list', value: items } }));

    const [key] = await readSessionKeys(fakeDb(client), ['l'], { byteCap: 1000, listWindow: 20 });

    expect(key.truncated).toBe(true);
    expect((key.value as string[]).length).toBe(10);
    expect(client.callsOf('lrangeBuffer')).toHaveLength(1);
  });

  it('reads a hash as a record of strings', async () => {
    const client = new FakeValkey(
      storeOf({ h: { type: 'hash', value: { a: '1', b: '2' }, memory: 50 } }),
    );
    const [key] = await readSessionKeys(fakeDb(client), ['h']);
    expect(key.value).toEqual({ a: '1', b: '2' });
    expect(client.callsOf('hgetallBuffer')).toHaveLength(1);
  });

  it('reads a hash larger than the cap with a bounded HSCAN', async () => {
    const client = new FakeValkey(
      storeOf({ h: { type: 'hash', value: { a: 'x'.repeat(60), b: 'y'.repeat(60) }, memory: 5000 } }),
    );
    const [key] = await readSessionKeys(fakeDb(client), ['h'], { byteCap: 100 });
    expect(client.callsOf('hgetallBuffer')).toHaveLength(0);
    expect(client.callsOf('hscanBuffer')).toHaveLength(1);
    expect(key.truncated).toBe(true);
    expect(Object.keys(key.value as object)).toEqual(['a']);
  });

  it('reads a sorted set as member and score pairs', async () => {
    const client = new FakeValkey(storeOf({ z: { type: 'zset', value: ['m1', '1', 'm2', '2.5'] } }));
    const [key] = await readSessionKeys(fakeDb(client), ['z']);
    expect(key.value).toEqual([
      ['m1', 1],
      ['m2', 2.5],
    ]);
  });

  it('returns ReJSON-RL values as the raw JSON.GET string', async () => {
    const client = new FakeValkey(storeOf({ j: { type: 'ReJSON-RL', value: '{"a":[1,2]}' } }));
    const [key] = await readSessionKeys(fakeDb(client), ['j']);
    expect(key.value).toBe('{"a":[1,2]}');
    expect(client.callsOf('call:JSON.GET')[0].args).toEqual(['j']);
  });

  it('applies the byte cap to JSON values', async () => {
    const doc = JSON.stringify({ text: 'z'.repeat(500) });
    const client = new FakeValkey(storeOf({ j: { type: 'ReJSON-RL', value: doc, memory: 300 } }));
    const [key] = await readSessionKeys(fakeDb(client), ['j'], { byteCap: 100 });
    expect(key.truncated).toBe(true);
    expect((key.value as string).length).toBe(100);
  });

  it('does not fetch a JSON document far beyond the cap', async () => {
    const client = new FakeValkey(
      storeOf({ j: { type: 'ReJSON-RL', value: '{}', memory: 100 * MB } }),
    );
    const [key] = await readSessionKeys(fakeDb(client), ['j'], { byteCap: MB });
    expect(key.truncated).toBe(true);
    expect(client.callsOf('call:JSON.GET')).toHaveLength(0);
  });

  it('omits a missing key', async () => {
    const client = new FakeValkey(storeOf({ k: { type: 'string', value: 'v' } }));
    const keys = await readSessionKeys(fakeDb(client), ['gone', 'k']);
    expect(keys.map((k) => k.key)).toEqual(['k']);
  });

  it('records memory usage as bytes', async () => {
    const client = new FakeValkey(storeOf({ k: { type: 'string', value: 'v', memory: 72 } }));
    const [key] = await readSessionKeys(fakeDb(client), ['k']);
    expect(key.bytes).toBe(72);
  });

  it('reads each key from the primary that owns it', async () => {
    const parent = new FakeValkey();
    const nodeA = new FakeValkey(storeOf({ a: { type: 'string', value: 'from-a' } }));
    const nodeB = new FakeValkey(storeOf({ b: { type: 'string', value: 'from-b' } }));
    const moved = (owner: FakeValkey, other: FakeValkey) => {
      const original = owner.pipeline.bind(owner);
      owner.pipeline = () => {
        const chain = original() as Record<string, (...a: unknown[]) => unknown>;
        const exec = chain.exec as () => Promise<Array<[Error | null, unknown]>>;
        const keysSeen: string[] = [];
        const type = chain.type;
        chain.type = (k: unknown) => {
          keysSeen.push(k as string);
          return type(k);
        };
        chain.exec = async () => {
          const results = await exec();
          const perKey = results.length / keysSeen.length;
          return results.map((r, i) =>
            other.store.has(keysSeen[Math.floor(i / perKey)])
              ? ([new Error('MOVED 1 x:1'), null] as [Error, null])
              : r,
          );
        };
        return chain;
      };
    };
    moved(nodeA, nodeB);
    moved(nodeB, nodeA);
    const byPort: Record<number, FakeValkey> = { 7001: nodeA, 7002: nodeB };
    ValkeyMock.mockImplementation((opts: { port: number }) => byPort[opts.port]);
    const db = fakeDb(parent, {
      nodes: [masterNode('a', '10.0.0.1:7001'), masterNode('b', '10.0.0.2:7002')],
    });

    const keys = await readSessionKeys(db, ['a', 'b']);

    expect(keys.map((k) => [k.key, k.value])).toEqual([
      ['a', 'from-a'],
      ['b', 'from-b'],
    ]);
    expect(nodeA.callsOf('getBuffer').map((c) => c.args[0])).toEqual(['a']);
    expect(nodeB.callsOf('getBuffer').map((c) => c.args[0])).toEqual(['b']);
    expect(nodeA.disconnected && nodeB.disconnected).toBe(true);
  });
});
