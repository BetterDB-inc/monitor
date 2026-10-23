import type Valkey from 'iovalkey';
import type { ChainableCommander } from 'iovalkey';
import calculateSlot from 'cluster-key-slot';
import type { CapturedKey, ValkeyElement, ValkeyValue } from '@betterdb/shared';
import type { DatabasePort } from '../common/interfaces/database-port.interface';
import { decodeValue } from './presets/text';
import { PrimaryClients, withPrimaries } from './primary-nodes';

export const DEFAULT_BYTE_CAP = 2 * 1024 * 1024;
export const DEFAULT_TOTAL_BYTE_CAP = 32 * 1024 * 1024;
export const DEFAULT_LIST_WINDOW = 500;
export const DEFAULT_READ_BATCH = 1000;
const JSON_MEMORY_HEADROOM = 4;

type PipelineResult = [Error | null, unknown] | undefined;

export interface SessionKeysRead {
  keys: CapturedKey[];
  truncated: boolean;
  failedNodes: number;
  missingKeys: number;
}

export interface ReadOptions {
  byteCap?: number;
  totalByteCap?: number;
  listWindow?: number;
  batch?: number;
}

interface ReadOpts {
  byteCap: number;
  totalByteCap: number;
  listWindow: number;
  batch: number;
}

interface Located {
  key: string;
  type: string;
  pttl: number;
  memory: number | null;
}

interface ReadResult {
  value: ValkeyValue;
  binary?: boolean;
  truncated: boolean;
  bytes: number;
}

class KeyReadError extends Error {}

const resultOf = (r: PipelineResult): unknown => {
  if (!r || r[0]) throw new KeyReadError();
  return r[1];
};

const numberOf = (r: PipelineResult): number | null =>
  r && !r[0] && typeof r[1] === 'number' ? r[1] : null;

const decoded = (buf: Buffer, cap: number): ValkeyElement => {
  const { value, binary } = decodeValue(buf, cap);
  return binary ? { base64: value } : value;
};

function decodeCut(buf: Buffer, cap: number, cut: boolean): ReadResult {
  return { ...decodeValue(buf, cap, cut), bytes: Math.min(buf.length, cap) };
}

class Accumulator<T> {
  items: T[] = [];
  bytes = 0;
  full = false;

  constructor(readonly cap: number) {}

  add(size: number, item: () => T): boolean {
    if (this.bytes + size > this.cap) {
      this.full = true;
      return false;
    }
    this.bytes += size;
    this.items.push(item());
    return true;
  }
}

const firstWindow = (at: Located, opts: ReadOpts): number =>
  at.memory !== null && at.memory <= opts.byteCap ? opts.listWindow : 1;

function nextWindow(acc: Accumulator<unknown>, opts: ReadOpts): number {
  const average = Math.max(1, acc.bytes / Math.max(1, acc.items.length));
  const fits = Math.floor((acc.cap - acc.bytes) / average) + 1;
  return Math.max(1, Math.min(opts.listWindow, fits));
}

function routeKeys(
  primaries: PrimaryClients,
  keys: string[],
): { groups: Map<Valkey, string[]>; unrouted: number } {
  const groups = new Map<Valkey, string[]>();
  let unrouted = 0;
  const add = (client: Valkey, key: string) => {
    const list = groups.get(client) ?? [];
    list.push(key);
    groups.set(client, list);
  };
  for (const key of keys) {
    if (!primaries.routes) {
      add(primaries.clients[0], key);
      continue;
    }
    const slot = calculateSlot(key);
    const route = primaries.routes.find((r) =>
      r.slots.some(([start, end]) => slot >= start && slot <= end),
    );
    if (route) add(route.client, key);
    else unrouted++;
  }
  return { groups, unrouted };
}

async function locate(
  client: Valkey,
  keys: string[],
  batch: number,
): Promise<{ located: Located[]; missing: number }> {
  const located: Located[] = [];
  let missing = 0;
  for (let start = 0; start < keys.length; start += batch) {
    const slice = keys.slice(start, start + batch);
    const pipeline = client.pipeline();
    for (const key of slice) {
      pipeline.type(key);
      pipeline.pttl(key);
      pipeline.memory('USAGE', key);
    }
    const results = (await pipeline.exec()) ?? [];
    slice.forEach((key, i) => {
      const [type, pttl, memory] = results.slice(i * 3, i * 3 + 3) as PipelineResult[];
      if (!type || type[0] || typeof type[1] !== 'string' || type[1] === 'none') {
        missing++;
        return;
      }
      located.push({ key, type: type[1], pttl: numberOf(pttl) ?? -1, memory: numberOf(memory) });
    });
  }
  return { located, missing };
}

function queueFirstRead(pipeline: ChainableCommander, at: Located, opts: ReadOpts): number {
  const { key, memory } = at;
  switch (at.type) {
    case 'string':
      pipeline.strlen(key);
      pipeline.getrangeBuffer(key, 0, opts.byteCap - 1);
      return 2;
    case 'list':
      pipeline.llen(key);
      pipeline.lrangeBuffer(key, 0, firstWindow(at, opts) - 1);
      return 2;
    case 'hash':
      if (memory === null || memory > opts.byteCap) return 0;
      pipeline.hgetallBuffer(key);
      return 1;
    case 'zset':
      pipeline.zcard(key);
      pipeline.zrangeBuffer(key, 0, String(firstWindow(at, opts) - 1), 'WITHSCORES');
      return 2;
    case 'ReJSON-RL':
      if (memory === null) {
        pipeline.call('JSON.DEBUG', 'MEMORY', key);
        return 1;
      }
      if (memory > opts.byteCap * JSON_MEMORY_HEADROOM) return 0;
      pipeline.callBuffer('JSON.GET', key);
      return 1;
    case 'stream':
      pipeline.xrangeBuffer(key, '-', '+', 'COUNT', firstWindow(at, opts));
      return 1;
    default:
      return 0;
  }
}

function readString(results: PipelineResult[], cap: number): ReadResult {
  const length = resultOf(results[0]) as number;
  const buf = resultOf(results[1]) as Buffer;
  return decodeCut(buf, cap, length > buf.length);
}

async function readList(
  client: Valkey,
  at: Located,
  results: PipelineResult[],
  cap: number,
  opts: ReadOpts,
): Promise<ReadResult> {
  const length = resultOf(results[0]) as number;
  let window = resultOf(results[1]) as Buffer[];
  const acc = new Accumulator<ValkeyValue>(cap);
  let size = firstWindow(at, opts);
  for (let start = 0; ; ) {
    for (const item of window) {
      if (!acc.add(item.length, () => decoded(item, cap))) break;
    }
    start += window.length;
    if (acc.full || window.length < size || start >= length) break;
    size = nextWindow(acc, opts);
    window = await client.lrangeBuffer(at.key, start, start + size - 1);
  }
  return { value: acc.items, truncated: acc.full, bytes: acc.bytes };
}

async function readHash(
  client: Valkey,
  at: Located,
  results: PipelineResult[],
  cap: number,
  opts: ReadOpts,
): Promise<ReadResult> {
  const acc = new Accumulator<[string, ValkeyValue]>(cap);
  if (results.length > 0) {
    const all = resultOf(results[0]) as Record<string, Buffer>;
    for (const [field, v] of Object.entries(all)) {
      if (!acc.add(Buffer.byteLength(field) + v.length, () => [field, decoded(v, cap)])) break;
    }
  } else {
    let cursor = '0';
    let count = firstWindow(at, opts);
    do {
      const [next, flat] = await client.hscanBuffer(at.key, cursor, 'COUNT', count);
      cursor = next.toString();
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const [field, v] = [flat[i], flat[i + 1]];
        if (!acc.add(field.length + v.length, () => [field.toString(), decoded(v, cap)])) break;
      }
      if (acc.items.length > 0) count = nextWindow(acc, opts);
    } while (cursor !== '0' && !acc.full);
  }
  return { value: Object.fromEntries(acc.items), truncated: acc.full, bytes: acc.bytes };
}

async function readZset(
  client: Valkey,
  at: Located,
  results: PipelineResult[],
  cap: number,
  opts: ReadOpts,
): Promise<ReadResult> {
  const length = resultOf(results[0]) as number;
  let flat = resultOf(results[1]) as Buffer[];
  const acc = new Accumulator<[ValkeyValue, number]>(cap);
  let size = firstWindow(at, opts);
  for (let start = 0; ; ) {
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const [member, score] = [flat[i], flat[i + 1]];
      if (!acc.add(member.length, () => [decoded(member, cap), Number(score.toString())])) break;
    }
    start += flat.length / 2;
    if (acc.full || flat.length < size * 2 || start >= length) break;
    size = nextWindow(acc, opts);
    flat = await client.zrangeBuffer(at.key, start, String(start + size - 1), 'WITHSCORES');
  }
  return { value: acc.items, truncated: acc.full, bytes: acc.bytes };
}

const UNREAD_JSON: ReadResult = { value: '', truncated: true, bytes: 0 };

async function readJson(
  client: Valkey,
  at: Located,
  results: PipelineResult[],
  cap: number,
  opts: ReadOpts,
): Promise<ReadResult | null> {
  const limit = opts.byteCap * JSON_MEMORY_HEADROOM;
  let buf: Buffer | null;
  if (at.memory === null) {
    const size = numberOf(results[0]);
    if (size === null || size > limit) return UNREAD_JSON;
    buf = (await client.callBuffer('JSON.GET', at.key)) as Buffer | null;
  } else if (at.memory > limit) {
    return UNREAD_JSON;
  } else {
    buf = resultOf(results[0]) as Buffer | null;
  }
  if (buf === null) return null;
  return { ...decodeValue(buf, cap), bytes: Math.min(buf.length, cap) };
}

const MAX_STREAM_SEQ = 2n ** 64n - 1n;

function streamIdAfter(id: string): string {
  const [ms, seq] = id.split('-').map(BigInt);
  return seq === MAX_STREAM_SEQ ? `${ms + 1n}-0` : `${ms}-${seq + 1n}`;
}

async function readStream(
  client: Valkey,
  at: Located,
  results: PipelineResult[],
  cap: number,
  opts: ReadOpts,
): Promise<ReadResult> {
  let entries = resultOf(results[0]) as Array<[Buffer, Buffer[]]>;
  const acc = new Accumulator<[string, Record<string, ValkeyValue>]>(cap);
  let size = firstWindow(at, opts);
  for (;;) {
    for (const [id, flat] of entries) {
      let entryBytes = 0;
      for (let i = 0; i + 1 < flat.length; i += 2) entryBytes += flat[i].length + flat[i + 1].length;
      const fields = () => {
        const out: Record<string, ValkeyValue> = {};
        for (let i = 0; i + 1 < flat.length; i += 2) {
          out[flat[i].toString()] = decoded(flat[i + 1], cap);
        }
        return out;
      };
      if (!acc.add(entryBytes, () => [id.toString(), fields()])) break;
    }
    if (acc.full || entries.length < size) break;
    const lastId = entries[entries.length - 1][0].toString();
    size = nextWindow(acc, opts);
    entries = (await client.xrangeBuffer(at.key, streamIdAfter(lastId), '+', 'COUNT', size)) as Array<
      [Buffer, Buffer[]]
    >;
  }
  return { value: acc.items, truncated: acc.full, bytes: acc.bytes };
}

function finishRead(
  client: Valkey,
  at: Located,
  results: PipelineResult[],
  cap: number,
  opts: ReadOpts,
): Promise<ReadResult | null> | ReadResult | null {
  switch (at.type) {
    case 'string':
      return readString(results, cap);
    case 'list':
      return readList(client, at, results, cap, opts);
    case 'hash':
      return readHash(client, at, results, cap, opts);
    case 'zset':
      return readZset(client, at, results, cap, opts);
    case 'ReJSON-RL':
      return readJson(client, at, results, cap, opts);
    case 'stream':
      return readStream(client, at, results, cap, opts);
    default:
      return { value: null, truncated: false, bytes: 0 };
  }
}

const estimate = (at: Located, opts: ReadOpts) =>
  Math.max(1, Math.min(at.memory ?? opts.byteCap, opts.byteCap));

interface ReadState {
  remaining: number;
  exhausted: boolean;
  missing: number;
  captured: Map<string, CapturedKey>;
}

async function readNode(
  client: Valkey,
  located: Located[],
  opts: ReadOpts,
  state: ReadState,
): Promise<void> {
  let next = 0;
  while (next < located.length) {
    if (state.remaining <= 0) {
      state.exhausted = true;
      return;
    }
    const batch: Located[] = [];
    let reserved = 0;
    while (next < located.length && batch.length < opts.batch) {
      const cost = estimate(located[next], opts);
      if (batch.length > 0 && reserved + cost > state.remaining) break;
      reserved += cost;
      batch.push(located[next++]);
    }

    const pipeline = client.pipeline();
    const counts = batch.map((at) => queueFirstRead(pipeline, at, opts));
    const results = counts.some((n) => n > 0) ? ((await pipeline.exec()) ?? []) : [];

    let offset = 0;
    for (const [i, at] of batch.entries()) {
      const own = results.slice(offset, offset + counts[i]) as PipelineResult[];
      offset += counts[i];
      try {
        const read = await finishRead(client, at, own, Math.min(opts.byteCap, state.remaining), opts);
        if (!read) {
          state.missing++;
          continue;
        }
        state.remaining -= read.bytes;
        state.captured.set(at.key, {
          key: at.key,
          type: at.type,
          pttl: at.pttl,
          value: read.value,
          ...(read.binary ? { binary: true } : {}),
          ...(read.truncated ? { truncated: true } : {}),
          ...(at.memory !== null ? { bytes: at.memory } : {}),
        });
      } catch {
        state.missing++;
      }
    }
  }
}

export async function readSessionKeys(
  db: DatabasePort,
  keys: string[],
  options: ReadOptions = {},
): Promise<SessionKeysRead> {
  const opts: ReadOpts = {
    byteCap: options.byteCap ?? DEFAULT_BYTE_CAP,
    totalByteCap: options.totalByteCap ?? DEFAULT_TOTAL_BYTE_CAP,
    listWindow: options.listWindow ?? DEFAULT_LIST_WINDOW,
    batch: options.batch ?? DEFAULT_READ_BATCH,
  };
  return withPrimaries(db, async (primaries) => {
    const { groups, unrouted } = routeKeys(primaries, keys);
    const state: ReadState = {
      remaining: opts.totalByteCap,
      exhausted: false,
      missing: unrouted,
      captured: new Map(),
    };
    let failedNodes = primaries.failed;
    let lastError: unknown;
    let succeeded = 0;

    for (const [client, nodeKeys] of groups) {
      if (state.exhausted) break;
      try {
        const { located, missing } = await locate(client, nodeKeys, opts.batch);
        state.missing += missing;
        await readNode(client, located, opts, state);
        succeeded++;
      } catch (err) {
        failedNodes++;
        lastError = err;
      }
    }

    if (succeeded === 0 && lastError !== undefined) throw lastError;

    return {
      keys: keys.flatMap((key) => {
        const captured = state.captured.get(key);
        return captured ? [captured] : [];
      }),
      truncated: state.exhausted,
      failedNodes,
      missingKeys: state.missing,
    };
  });
}
