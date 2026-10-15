import type { SamplerClient } from '../sample-types';

export interface FakeKey {
  type: string;
  size: number | null;
}

export interface FakeOptions {
  memoryError?: string;
  scanTypeError?: string;
  seed?: number;
}

function shuffled(names: string[], seed: number): string[] {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const result = [...names];
  for (let index = result.length - 1; index > 0; index--) {
    const swap = Math.floor(next() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

export function fakeClient(keys: Map<string, FakeKey>, options: FakeOptions = {}): SamplerClient {
  const names = shuffled([...keys.keys()], options.seed ?? 1);
  const call = async (command: string, args: string[]): Promise<unknown> => {
    if (command !== 'SCAN') throw new Error(`unexpected ${command}`);
    const [cursor, , count, typeFlag, type] = args;
    if (typeFlag === 'TYPE' && options.scanTypeError) throw new Error(options.scanTypeError);
    const start = Number(cursor);
    const end = Math.min(names.length, start + Number(count));
    const page = names.slice(start, end).filter((name) => !type || keys.get(name)?.type === type);
    return [end >= names.length ? '0' : String(end), page];
  };
  const pipeline = () => {
    const queued: string[][] = [];
    const chain = {
      call: (...parts: string[]) => {
        queued.push(parts);
        return chain;
      },
      exec: async () =>
        queued.map((parts): [Error | null, unknown] => {
          const entry = keys.get(parts[parts[0] === 'TYPE' ? 1 : 2]);
          if (parts[0] === 'TYPE') return [null, entry?.type ?? 'none'];
          if (options.memoryError) return [new Error(options.memoryError), null];
          return [null, entry?.size ?? null];
        }),
    };
    return chain;
  };
  return { call, getClient: () => ({ pipeline }), getDbSize: async () => keys.size } as unknown as SamplerClient;
}

export function keyspace(count: number, pick: (index: number) => FakeKey): Map<string, FakeKey> {
  const keys = new Map<string, FakeKey>();
  for (let index = 0; index < count; index++) keys.set(`k${index}`, pick(index));
  return keys;
}
