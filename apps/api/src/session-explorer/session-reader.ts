import type Valkey from 'iovalkey';
import type { ChainableCommander } from 'iovalkey';
import type { CapturedKey, ValkeyElement, ValkeyValue } from '@betterdb/shared';
import { decodeValue } from './presets/text';
import {
  isReadable,
  ownerOf,
  PrimaryClients,
  PrimaryRoute,
  ReadableRoute,
  union,
} from './primary-nodes';

export const DEFAULT_BYTE_CAP = 2 * 1024 * 1024;
export const DEFAULT_TOTAL_BYTE_CAP = 32 * 1024 * 1024;
export const DEFAULT_LIST_WINDOW = 500;
export const DEFAULT_READ_BATCH = 1000;
export const UNMEASURED_WINDOW = 4;
export const EXACT_MEMORY_LENGTH = 128;
const JSON_MEMORY_HEADROOM = 4;

type PipelineResult = [Error | null, unknown] | undefined;

export interface SessionTotals {
  memoryBytes: number;
  unmeasuredKeys: number;
  goneKeys: number;
  ttlMs: number | null;
}

export interface SessionKeysRead {
  keys: CapturedKey[];
  truncated: boolean;
  failed: Set<PrimaryRoute>;
  missingKeys: number;
  touchesKeys: boolean;
  totals: SessionTotals;
}

export interface ReadOptions {
  selected?: string[];
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
  length: number | null;
  exact: boolean;
}

interface ReadResult {
  value: ValkeyValue;
  binary?: boolean;
  truncated: boolean;
  bytes: number;
  fetched: number;
}

const LENGTH_COMMANDS = {
  list: 'llen',
  hash: 'hlen',
  set: 'scard',
  zset: 'zcard',
  stream: 'xlen',
} as const;

const isCollection = (type: string): type is keyof typeof LENGTH_COMMANDS =>
  type in LENGTH_COMMANDS;

class KeyReadError extends Error {}

const resultOf = (r: PipelineResult): unknown => {
  if (!r) throw new KeyReadError();
  if (r[0]) throw r[0];
  return r[1];
};

const isMoved = (err: unknown): boolean =>
  err instanceof Error && /^(MOVED|ASK) /.test(err.message);

const numberOf = (r: PipelineResult): number | null =>
  r && !r[0] && typeof r[1] === 'number' ? r[1] : null;

const lengthOf = (at: Located): number => {
  if (at.length === null) throw new KeyReadError();
  return at.length;
};

const minPositive = (values: number[]): number | null => {
  const positive = values.filter((v) => v > 0);
  return positive.length > 0 ? Math.min(...positive) : null;
};

const bulk = (length: number): number => length + String(length).length + 5;

const arrayHeader = (count: number): number => String(count).length + 3;

const decoded = (buf: Buffer, cap: number): ValkeyElement => {
  const { value, binary } = decodeValue(buf, cap);
  return binary ? { base64: value } : value;
};

class Accumulator<T> {
  items: T[] = [];
  bytes = 0;
  fetched = 0;
  largest = 0;
  full = false;
  skipped = false;

  constructor(readonly cap: number) {}

  add(size: number, item: () => T): boolean {
    this.fetched += size;
    this.largest = Math.max(this.largest, size);
    if (this.full || this.bytes + size > this.cap) {
      this.full = true;
      return false;
    }
    this.bytes += size;
    this.items.push(item());
    return true;
  }

  result(value: ValkeyValue): ReadResult {
    return {
      value,
      truncated: this.full || this.skipped,
      bytes: this.bytes,
      fetched: this.fetched,
    };
  }
}

const hasOversizedElements = (at: Located, opts: ReadOpts): boolean =>
  isCollection(at.type) &&
  at.memory !== null &&
  at.length !== null &&
  at.length > 0 &&
  at.memory / at.length > opts.byteCap;

const readsWhole = (at: Located, opts: ReadOpts): boolean =>
  at.exact && at.memory !== null && at.memory <= opts.byteCap && at.type !== 'list';

function nextWindow(
  acc: Accumulator<unknown>,
  at: Located,
  read: number,
  previous: number,
  opts: ReadOpts,
): number {
  const unreadBytes = at.memory === null ? 0 : at.memory - acc.fetched;
  const left = Math.max(1, (at.length ?? 0) - read);
  const pessimistic = Math.max(acc.largest, unreadBytes > 0 ? unreadBytes / left : 0);
  const fit =
    pessimistic > 0
      ? Math.floor((acc.cap - acc.bytes) / pessimistic) + 1
      : Number.POSITIVE_INFINITY;
  const ceiling = at.memory === null ? UNMEASURED_WINDOW : opts.listWindow;
  return Math.max(1, Math.min(ceiling, previous * 2, fit));
}

type Window = (read: number, size: number) => Promise<[number, boolean]>;

async function readWindows(
  acc: Accumulator<unknown>,
  at: Located,
  opts: ReadOpts,
  fetch: Window,
): Promise<void> {
  let read = 0;
  let size = 0;
  let more = true;
  while (more && !acc.full) {
    size = nextWindow(acc, at, read, size, opts);
    let received: number;
    [received, more] = await fetch(read, size);
    read += received;
  }
}

function routeKeys(
  primaries: PrimaryClients,
  keys: string[],
): { groups: Map<ReadableRoute, string[]>; unrouted: Map<PrimaryRoute, string[]> } {
  const groups = new Map<ReadableRoute, string[]>();
  const unrouted = new Map<PrimaryRoute, string[]>();
  for (const key of keys) {
    const route = ownerOf(primaries, key);
    if (isReadable(route)) groups.set(route, [...(groups.get(route) ?? []), key]);
    else unrouted.set(route, [...(unrouted.get(route) ?? []), key]);
  }
  return { groups, unrouted };
}

async function measure(client: Valkey, found: Located[]): Promise<void> {
  const collections = found.filter((at) => isCollection(at.type));
  if (collections.length > 0) {
    const lengths = client.pipeline();
    for (const at of collections) {
      if (isCollection(at.type)) lengths[LENGTH_COMMANDS[at.type]](at.key);
    }
    const counted = (await lengths.exec()) ?? [];
    collections.forEach((at, i) => {
      at.length = numberOf(counted[i] as PipelineResult);
    });
  }

  const exactly = found.filter(
    (at) =>
      at.type === 'ReJSON-RL' ||
      at.type === 'list' ||
      (at.length !== null && at.length <= EXACT_MEMORY_LENGTH),
  );
  if (exactly.length === 0) return;
  const exact = client.pipeline();
  for (const at of exactly) exact.memory('USAGE', at.key, 'SAMPLES', 0);
  const measured = (await exact.exec()) ?? [];
  exactly.forEach((at, i) => {
    at.memory = numberOf(measured[i] as PipelineResult);
    at.exact = at.memory !== null;
  });
}

async function locate(
  client: Valkey,
  keys: string[],
  batch: number,
): Promise<{ located: Located[]; missing: string[]; errored: string[]; moved: string[] }> {
  const located: Located[] = [];
  const missing: string[] = [];
  const errored: string[] = [];
  const moved: string[] = [];
  for (let start = 0; start < keys.length; start += batch) {
    const slice = keys.slice(start, start + batch);
    const pipeline = client.pipeline();
    for (const key of slice) {
      pipeline.type(key);
      pipeline.pttl(key);
      pipeline.memory('USAGE', key);
    }
    const results = (await pipeline.exec()) ?? [];
    const found: Located[] = [];
    slice.forEach((key, i) => {
      const [type, pttl, memory] = results.slice(i * 3, i * 3 + 3) as PipelineResult[];
      if (type && isMoved(type[0])) {
        moved.push(key);
        return;
      }
      if (!type || type[0] || typeof type[1] !== 'string') {
        errored.push(key);
        return;
      }
      if (type[1] === 'none') {
        missing.push(key);
        return;
      }
      found.push({
        key,
        type: type[1],
        pttl: numberOf(pttl) ?? -1,
        memory: numberOf(memory),
        length: null,
        exact: false,
      });
    });
    await measure(client, found);
    located.push(...found);
  }
  return { located, missing, errored, moved };
}

function queueFirstRead(
  pipeline: ChainableCommander,
  at: Located,
  cap: number,
  opts: ReadOpts,
): number {
  const { key, memory } = at;
  switch (at.type) {
    case 'string':
      pipeline.strlen(key);
      pipeline.getrangeBuffer(key, 0, cap - 1);
      return 2;
    case 'ReJSON-RL':
      if (memory !== null) return 0;
      pipeline.call('JSON.DEBUG', 'MEMORY', key);
      return 1;
  }
  if (!readsWhole(at, opts)) return 0;
  switch (at.type) {
    case 'hash':
      pipeline.hgetallBuffer(key);
      return 1;
    case 'set':
      pipeline.smembersBuffer(key);
      return 1;
    case 'zset':
      pipeline.zrangeBuffer(key, 0, String(lengthOf(at) - 1), 'WITHSCORES');
      return 1;
    case 'stream':
      pipeline.xrangeBuffer(key, '-', '+', 'COUNT', lengthOf(at));
      return 1;
    default:
      return 0;
  }
}

function readString(results: PipelineResult[], cap: number): ReadResult {
  const length = resultOf(results[0]) as number;
  const buf = resultOf(results[1]) as Buffer;
  return {
    ...decodeValue(buf, cap, length > buf.length),
    bytes: Math.min(buf.length, cap),
    fetched: buf.length,
  };
}

async function readList(
  client: Valkey,
  at: Located,
  cap: number,
  opts: ReadOpts,
): Promise<ReadResult> {
  const length = lengthOf(at);
  const acc = new Accumulator<ValkeyValue>(cap);
  await readWindows(acc, at, opts, async (read, size) => {
    const window = await client.lrangeBuffer(at.key, read, read + size - 1);
    for (const item of window) acc.add(bulk(item.length), () => decoded(item, cap));
    return [window.length, window.length === size && read + size < length];
  });
  return acc.result(acc.items);
}

async function readHash(
  client: Valkey,
  at: Located,
  results: PipelineResult[],
  cap: number,
  opts: ReadOpts,
): Promise<ReadResult> {
  lengthOf(at);
  const acc = new Accumulator<[string, ValkeyValue]>(cap);
  if (readsWhole(at, opts)) {
    const all = resultOf(results[0]) as Record<string, Buffer>;
    for (const [field, v] of Object.entries(all)) {
      acc.add(bulk(Buffer.byteLength(field)) + bulk(v.length), () => [field, decoded(v, cap)]);
    }
  } else {
    let cursor = '0';
    let probing = true;
    await readWindows(acc, at, opts, async (_, size) => {
      if (probing) {
        try {
          const [next, fields] = await client.hscanBuffer(
            at.key,
            cursor,
            'COUNT',
            size,
            'NOVALUES',
          );
          await readProbedFields(client, at, acc, fields, cap);
          cursor = next.toString();
          return [fields.length, cursor !== '0'];
        } catch (err) {
          if (isMoved(err)) throw err;
          probing = false;
        }
      }
      if (hasOversizedElements(at, opts)) {
        acc.skipped = true;
        return [0, false];
      }
      const [next, flat] = await client.hscanBuffer(at.key, cursor, 'COUNT', size);
      cursor = next.toString();
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const [field, v] = [flat[i], flat[i + 1]];
        acc.add(bulk(field.length) + bulk(v.length), () => [field.toString(), decoded(v, cap)]);
      }
      return [flat.length / 2, cursor !== '0'];
    });
  }
  return acc.result(Object.fromEntries(acc.items));
}

async function readProbedFields(
  client: Valkey,
  at: Located,
  acc: Accumulator<[string, ValkeyValue]>,
  fields: Buffer[],
  cap: number,
): Promise<void> {
  if (fields.length === 0) return;
  const probe = client.pipeline();
  for (const field of fields) probe.hstrlen(at.key, field);
  const lengths = (await probe.exec()) ?? [];
  let room = acc.cap - acc.bytes;
  const wanted: Buffer[] = [];
  for (const [i, field] of fields.entries()) {
    const length = numberOf(lengths[i] as PipelineResult);
    const cost = length === null ? null : bulk(field.length) + bulk(length);
    if (cost === null || cost > acc.cap) {
      acc.skipped = true;
      continue;
    }
    if (cost > room) {
      acc.full = true;
      break;
    }
    room -= cost;
    wanted.push(field);
  }
  if (wanted.length > 0) {
    const values = await client.hmgetBuffer(at.key, ...wanted);
    wanted.forEach((field, i) => {
      const v = values[i];
      if (!v) return;
      acc.add(bulk(field.length) + bulk(v.length), () => [field.toString(), decoded(v, cap)]);
    });
  }
}

async function readSet(
  client: Valkey,
  at: Located,
  results: PipelineResult[],
  cap: number,
  opts: ReadOpts,
): Promise<ReadResult> {
  lengthOf(at);
  const acc = new Accumulator<ValkeyElement>(cap);
  const addMembers = (members: Buffer[]) => {
    for (const member of members) acc.add(bulk(member.length), () => decoded(member, cap));
  };
  if (readsWhole(at, opts)) {
    addMembers(resultOf(results[0]) as Buffer[]);
  } else {
    let cursor = '0';
    await readWindows(acc, at, opts, async (_, size) => {
      const [next, members] = await client.sscanBuffer(at.key, cursor, 'COUNT', size);
      cursor = next.toString();
      addMembers(members);
      return [members.length, cursor !== '0'];
    });
  }
  return acc.result(acc.items);
}

async function readZset(
  client: Valkey,
  at: Located,
  results: PipelineResult[],
  cap: number,
  opts: ReadOpts,
): Promise<ReadResult> {
  const length = lengthOf(at);
  const acc = new Accumulator<[ValkeyValue, number]>(cap);
  const addPairs = (flat: Buffer[]) => {
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const [member, score] = [flat[i], flat[i + 1]];
      acc.add(bulk(member.length) + bulk(score.length), () => [
        decoded(member, cap),
        Number(score.toString()),
      ]);
    }
  };
  if (readsWhole(at, opts)) {
    addPairs(resultOf(results[0]) as Buffer[]);
  } else {
    await readWindows(acc, at, opts, async (read, size) => {
      const flat = await client.zrangeBuffer(at.key, read, String(read + size - 1), 'WITHSCORES');
      addPairs(flat);
      const received = flat.length / 2;
      return [received, received === size && read + size < length];
    });
  }
  return acc.result(acc.items);
}

const UNREAD_JSON: ReadResult = { value: '', truncated: true, bytes: 0, fetched: 0 };

async function readJson(
  client: Valkey,
  at: Located,
  results: PipelineResult[],
  cap: number,
  opts: ReadOpts,
): Promise<ReadResult | null> {
  const size = at.memory ?? numberOf(results[0]);
  if (size === null || size > opts.byteCap * JSON_MEMORY_HEADROOM) return UNREAD_JSON;
  const buf = (await client.callBuffer('JSON.GET', at.key)) as Buffer | null;
  if (buf === null) return null;
  return { ...decodeValue(buf, cap), bytes: Math.min(buf.length, cap), fetched: buf.length };
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
  const length = lengthOf(at);
  const acc = new Accumulator<[string, Record<string, ValkeyValue>]>(cap);
  const addEntries = (entries: Array<[Buffer, Buffer[]]>) => {
    for (const [id, flat] of entries) {
      let size = arrayHeader(2) + bulk(id.length) + arrayHeader(flat.length);
      for (const part of flat) size += bulk(part.length);
      acc.add(size, () => {
        const fields: Record<string, ValkeyValue> = {};
        for (let i = 0; i + 1 < flat.length; i += 2) {
          fields[flat[i].toString()] = decoded(flat[i + 1], cap);
        }
        return [id.toString(), fields];
      });
    }
  };
  if (readsWhole(at, opts)) {
    addEntries(resultOf(results[0]) as Array<[Buffer, Buffer[]]>);
  } else {
    let from = '-';
    await readWindows(acc, at, opts, async (read, size) => {
      const entries = (await client.xrangeBuffer(at.key, from, '+', 'COUNT', size)) as Array<
        [Buffer, Buffer[]]
      >;
      addEntries(entries);
      if (entries.length > 0) from = streamIdAfter(entries[entries.length - 1][0].toString());
      return [entries.length, entries.length === size && read + size < length];
    });
  }
  return acc.result(acc.items);
}

function finishRead(
  client: Valkey,
  at: Located,
  results: PipelineResult[],
  cap: number,
  opts: ReadOpts,
): Promise<ReadResult | null> | ReadResult | null {
  if (at.type !== 'hash' && hasOversizedElements(at, opts)) {
    return { value: at.type === 'hash' ? {} : [], truncated: true, bytes: 0, fetched: 0 };
  }
  switch (at.type) {
    case 'string':
      return readString(results, cap);
    case 'list':
      return readList(client, at, cap, opts);
    case 'hash':
      return readHash(client, at, results, cap, opts);
    case 'set':
      return readSet(client, at, results, cap, opts);
    case 'zset':
      return readZset(client, at, results, cap, opts);
    case 'ReJSON-RL':
      return readJson(client, at, results, cap, opts);
    case 'stream':
      return readStream(client, at, results, cap, opts);
    default:
      return { value: null, truncated: true, bytes: 0, fetched: 0 };
  }
}

function reservation(at: Located, opts: ReadOpts): number {
  if (at.type === 'string') {
    return Math.max(1, Math.min(at.memory ?? opts.byteCap, opts.byteCap));
  }
  return readsWhole(at, opts) ? Math.max(1, at.memory ?? 0) : 0;
}

interface ReadState {
  remaining: number;
  exhausted: boolean;
  missing: number;
  moved: Set<PrimaryRoute>;
  captured: Map<string, CapturedKey>;
}

async function readNode(
  route: ReadableRoute,
  located: Located[],
  opts: ReadOpts,
  state: ReadState,
): Promise<void> {
  const { client } = route;
  let next = 0;
  while (next < located.length) {
    if (state.remaining <= 0) {
      state.exhausted = true;
      return;
    }
    const batch: Located[] = [];
    let reserved = 0;
    while (next < located.length && batch.length < opts.batch) {
      const cost = reservation(located[next], opts);
      if (batch.length > 0 && reserved + cost > state.remaining) break;
      reserved += cost;
      batch.push(located[next++]);
    }

    const pipeline = client.pipeline();
    const firstCap = Math.min(opts.byteCap, state.remaining);
    const counts = batch.map((at) => queueFirstRead(pipeline, at, firstCap, opts));
    const results = counts.some((n) => n > 0) ? ((await pipeline.exec()) ?? []) : [];

    let offset = 0;
    for (const [i, at] of batch.entries()) {
      const own = results.slice(offset, offset + counts[i]) as PipelineResult[];
      offset += counts[i];
      if (state.remaining <= 0) {
        state.exhausted = true;
        return;
      }
      try {
        const read = await finishRead(
          client,
          at,
          own,
          Math.min(opts.byteCap, state.remaining),
          opts,
        );
        if (!read) {
          state.missing++;
          continue;
        }
        state.remaining -= read.fetched;
        state.captured.set(at.key, {
          key: at.key,
          type: at.type,
          pttl: at.pttl,
          value: read.value,
          ...(read.binary ? { binary: true } : {}),
          ...(read.truncated ? { truncated: true } : {}),
          ...(at.memory !== null ? { bytes: at.memory } : {}),
        });
      } catch (err) {
        if (isMoved(err)) state.moved.add(route);
        else state.missing++;
      }
    }
  }
}

export async function readSessionKeysOn(
  primaries: PrimaryClients,
  keys: string[],
  options: ReadOptions = {},
): Promise<SessionKeysRead> {
  const opts: ReadOpts = {
    byteCap: options.byteCap ?? DEFAULT_BYTE_CAP,
    totalByteCap: options.totalByteCap ?? DEFAULT_TOTAL_BYTE_CAP,
    listWindow: options.listWindow ?? DEFAULT_LIST_WINDOW,
    batch: options.batch ?? DEFAULT_READ_BATCH,
  };
  const selected = options.selected ? new Set(options.selected) : null;
  const isSelected = (key: string) => selected === null || selected.has(key);
  const { groups, unrouted } = routeKeys(primaries, keys);
  const failed = new Set<PrimaryRoute>();
  const state: ReadState = {
    remaining: opts.totalByteCap,
    exhausted: false,
    missing: 0,
    moved: new Set(),
    captured: new Map(),
  };
  const totals = { memoryBytes: 0, unmeasuredKeys: 0, goneKeys: 0, ttls: [] as number[] };
  for (const [route, owned] of unrouted) {
    totals.unmeasuredKeys += owned.length;
    if (owned.some(isSelected)) failed.add(route);
  }
  let lastError: unknown;
  let succeeded = 0;

  for (const [route, nodeKeys] of groups) {
    let measured = false;
    try {
      const { located, missing, errored, moved } = await locate(route.client, nodeKeys, opts.batch);
      measured = true;
      for (const at of located) {
        totals.memoryBytes += at.memory ?? 0;
        totals.ttls.push(at.pttl);
      }
      const missingSelected = missing.filter(isSelected).length;
      const erroredSelected = errored.filter(isSelected).length;
      totals.goneKeys += missing.length - missingSelected;
      totals.unmeasuredKeys +=
        missingSelected +
        errored.length +
        moved.length +
        located.filter((at) => at.memory === null).length;
      state.missing += missingSelected + erroredSelected;
      if (moved.some(isSelected)) state.moved.add(route);
      if (!state.exhausted) {
        await readNode(route, located.filter((at) => isSelected(at.key)), opts, state);
      }
      succeeded++;
    } catch (err) {
      if (!measured) totals.unmeasuredKeys += nodeKeys.length;
      if (nodeKeys.some(isSelected)) failed.add(route);
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
    failed: union(failed, state.moved),
    missingKeys: state.missing,
    touchesKeys: primaries.touchesKeys,
    totals: {
      memoryBytes: totals.memoryBytes,
      unmeasuredKeys: totals.unmeasuredKeys,
      goneKeys: totals.goneKeys,
      ttlMs: minPositive(totals.ttls),
    },
  };
}
