import type Valkey from 'iovalkey';
import type { CapturedKey, ValkeyValue } from '@betterdb/shared';
import type { DatabasePort } from '../common/interfaces/database-port.interface';
import { decodeValue } from './presets/text';
import { withPrimaries } from './primary-nodes';

export const DEFAULT_BYTE_CAP = 2 * 1024 * 1024;
export const DEFAULT_LIST_WINDOW = 500;
const JSON_MEMORY_HEADROOM = 4;

type PipelineResult = [Error | null, unknown] | undefined;

interface Located {
  client: Valkey;
  type: string;
  pttl: number;
  memory: number | null;
}

interface ReadResult {
  value: ValkeyValue;
  truncated: boolean;
}

interface ReadOpts {
  byteCap: number;
  listWindow: number;
}

const decoded = (buf: Buffer, cap: number) => decodeValue(buf, cap).value;

async function locate(clients: Valkey[], keys: string[]): Promise<Map<string, Located>> {
  const located = new Map<string, Located>();
  for (const client of clients) {
    const pending = keys.filter((key) => !located.has(key));
    if (pending.length === 0) break;
    const pipeline = client.pipeline();
    for (const key of pending) {
      pipeline.type(key);
      pipeline.pttl(key);
      pipeline.memory('USAGE', key);
    }
    const results = (await pipeline.exec()) ?? [];
    pending.forEach((key, i) => {
      const [type, pttl, memory] = results.slice(i * 3, i * 3 + 3) as PipelineResult[];
      if (!type || type[0] || typeof type[1] !== 'string') return;
      located.set(key, {
        client,
        type: type[1],
        pttl: pttl && !pttl[0] && typeof pttl[1] === 'number' ? pttl[1] : -1,
        memory: memory && !memory[0] && typeof memory[1] === 'number' ? memory[1] : null,
      });
    });
  }
  return located;
}

async function readString(
  client: Valkey,
  key: string,
  { byteCap }: ReadOpts,
): Promise<ReadResult | null> {
  const length = await client.strlen(key);
  const buf =
    length > byteCap ? await client.getrangeBuffer(key, 0, byteCap) : await client.getBuffer(key);
  return buf === null ? null : decodeValue(buf, byteCap);
}

async function readList(client: Valkey, key: string, opts: ReadOpts): Promise<ReadResult> {
  const length = await client.llen(key);
  const items: ValkeyValue[] = [];
  let bytes = 0;
  for (let start = 0; start < length; start += opts.listWindow) {
    const window = await client.lrangeBuffer(key, start, start + opts.listWindow - 1);
    for (const item of window) {
      if (bytes + item.length > opts.byteCap) return { value: items, truncated: true };
      bytes += item.length;
      items.push(decoded(item, opts.byteCap));
    }
    if (window.length < opts.listWindow) break;
  }
  return { value: items, truncated: false };
}

async function readHash(
  client: Valkey,
  key: string,
  memory: number | null,
  opts: ReadOpts,
): Promise<ReadResult> {
  if (memory !== null && memory <= opts.byteCap) {
    const all = await client.hgetallBuffer(key);
    return {
      value: Object.fromEntries(
        Object.entries(all).map(([field, v]) => [field, decoded(v, opts.byteCap)]),
      ),
      truncated: false,
    };
  }
  const fields: Record<string, ValkeyValue> = {};
  let bytes = 0;
  let cursor = '0';
  do {
    const [next, flat] = await client.hscanBuffer(key, cursor, 'COUNT', opts.listWindow);
    cursor = next.toString();
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const size = flat[i].length + flat[i + 1].length;
      if (bytes + size > opts.byteCap) return { value: fields, truncated: true };
      bytes += size;
      fields[flat[i].toString()] = decoded(flat[i + 1], opts.byteCap);
    }
  } while (cursor !== '0');
  return { value: fields, truncated: false };
}

async function readZset(client: Valkey, key: string, opts: ReadOpts): Promise<ReadResult> {
  const pairs: Array<[ValkeyValue, number]> = [];
  let bytes = 0;
  for (let start = 0; ; start += opts.listWindow) {
    const flat = await client.zrangeBuffer(
      key,
      start,
      String(start + opts.listWindow - 1),
      'WITHSCORES',
    );
    for (let i = 0; i + 1 < flat.length; i += 2) {
      if (bytes + flat[i].length > opts.byteCap) return { value: pairs, truncated: true };
      bytes += flat[i].length;
      pairs.push([decoded(flat[i], opts.byteCap), Number(flat[i + 1].toString())]);
    }
    if (flat.length < opts.listWindow * 2) break;
  }
  return { value: pairs, truncated: false };
}

async function readJson(
  client: Valkey,
  key: string,
  memory: number | null,
  { byteCap }: ReadOpts,
): Promise<ReadResult | null> {
  if (memory !== null && memory > byteCap * JSON_MEMORY_HEADROOM) {
    return { value: '', truncated: true };
  }
  const buf = (await client.callBuffer('JSON.GET', key)) as Buffer | null;
  return buf === null ? null : decodeValue(buf, byteCap);
}

async function readStream(client: Valkey, key: string, opts: ReadOpts): Promise<ReadResult> {
  const entries = await client.xrangeBuffer(key, '-', '+', 'COUNT', opts.listWindow + 1);
  const value: Array<[string, Record<string, ValkeyValue>]> = [];
  let bytes = 0;
  for (const [id, flat] of entries.slice(0, opts.listWindow)) {
    const fields: Record<string, ValkeyValue> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const size = flat[i].length + flat[i + 1].length;
      if (bytes + size > opts.byteCap) return { value, truncated: true };
      bytes += size;
      fields[flat[i].toString()] = decoded(flat[i + 1], opts.byteCap);
    }
    value.push([id.toString(), fields]);
  }
  return { value, truncated: entries.length > opts.listWindow };
}

function readValue(key: string, at: Located, opts: ReadOpts): Promise<ReadResult | null> {
  switch (at.type) {
    case 'string':
      return readString(at.client, key, opts);
    case 'list':
      return readList(at.client, key, opts);
    case 'hash':
      return readHash(at.client, key, at.memory, opts);
    case 'zset':
      return readZset(at.client, key, opts);
    case 'ReJSON-RL':
      return readJson(at.client, key, at.memory, opts);
    case 'stream':
      return readStream(at.client, key, opts);
    default:
      return Promise.resolve({ value: null, truncated: false });
  }
}

export async function readSessionKeys(
  db: DatabasePort,
  keys: string[],
  opts: { byteCap?: number; listWindow?: number } = {},
): Promise<CapturedKey[]> {
  const readOpts: ReadOpts = {
    byteCap: opts.byteCap ?? DEFAULT_BYTE_CAP,
    listWindow: opts.listWindow ?? DEFAULT_LIST_WINDOW,
  };
  return withPrimaries(db, async ({ clients }) => {
    const located = await locate(clients, keys);
    const captured: CapturedKey[] = [];
    for (const key of keys) {
      const at = located.get(key);
      if (!at || at.type === 'none') continue;
      const read = await readValue(key, at, readOpts);
      if (!read) continue;
      const { value, truncated } = read;
      captured.push({
        key,
        type: at.type,
        pttl: at.pttl,
        value,
        ...(truncated ? { truncated: true } : {}),
        ...(at.memory !== null ? { bytes: at.memory } : {}),
      });
    }
    return captured;
  });
}
