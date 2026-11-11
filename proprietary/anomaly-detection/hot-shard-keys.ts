export const HOT_KEY_SLOTS = 3;
export const HOT_KEY_NAMES_PER_SLOT = 500;
export const HOT_KEY_TOP = 10;
export const HOT_KEY_REFRESH_MS = 5 * 60_000;
export const HOT_KEY_NAME_LIMIT = 64;

const MESSAGE_KEYS = 3;
const UNSAFE_IN_DISPLAY = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}"\\]/gu;
const SLOT_MOVED = /^(MOVED|ASK) /;
const SHORT_NOTES: ReadonlyArray<[RegExp, string]> = [
  [/LFU/, 'no LFU policy'],
  [/may not run/, 'no permission'],
  [/does not support/, 'not supported by the server'],
  [/timed out/, 'the hot primary did not answer'],
  [/hot primary failed/, 'the read from the hot primary failed'],
];

export type HotKeySource = 'lfu' | 'unavailable';

export interface HotShardKey {
  key: string;
  slot: number;
  freq: number;
}

export interface HotKeyRead {
  topKeys: HotShardKey[];
  keySource: HotKeySource;
  keyNote?: string;
  keysSampled: number;
}

export interface HotShardKeyDetail extends HotKeyRead {
  keysSampledAt?: number;
}

type CommandArg = string | number | Buffer;

interface HotKeyPipeline {
  call(command: string, ...args: CommandArg[]): unknown;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface HotKeyReader {
  callBuffer(command: string, ...args: CommandArg[]): Promise<unknown>;
  pipeline(): HotKeyPipeline;
}

export function hotKeysUnavailable(keyNote: string): HotKeyRead {
  return { keySource: 'unavailable', keyNote, keysSampled: 0, topKeys: [] };
}

export function hotKeysAfterRead(
  last: HotShardKeyDetail | undefined,
  read: HotKeyRead,
  readAt: number,
): HotShardKeyDetail {
  if (read.topKeys.length > 0 || !last || last.topKeys.length === 0) {
    return { ...read, keysSampledAt: readAt };
  }
  const why = read.keyNote === undefined ? '' : ` (${read.keyNote})`;
  return { ...last, keyNote: `the last read gave no names${why}; these are from an earlier read` };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function keysInSlotRefusal(error: unknown): string | undefined {
  const message = messageOf(error);
  if (/^NOPERM/i.test(message)) return 'the monitoring user may not run CLUSTER GETKEYSINSLOT';
  if (/unknown (sub)?command/i.test(message)) {
    return 'the server does not support CLUSTER GETKEYSINSLOT';
  }
  return undefined;
}

function objectFreqRefusal(error: Error): string | undefined {
  if (/LFU maxmemory policy/i.test(error.message)) {
    return 'maxmemory-policy is not an LFU policy, so the node keeps no access frequency';
  }
  if (/^NOPERM/i.test(error.message)) {
    return 'the monitoring user may not run OBJECT FREQ on these keys';
  }
  if (/unknown (sub)?command/i.test(error.message)) {
    return 'the server does not support OBJECT FREQ';
  }
  return undefined;
}

interface RankedKey extends HotShardKey {
  slotRank: number;
}

function hotterFirst(a: RankedKey, b: RankedKey): number {
  if (a.freq !== b.freq) return b.freq - a.freq;
  if (a.slotRank !== b.slotRank) return a.slotRank - b.slotRank;
  if (a.key === b.key) return 0;
  return a.key < b.key ? -1 : 1;
}

export async function sampleHotKeys(
  client: HotKeyReader,
  slots: readonly number[],
): Promise<HotKeyRead> {
  const read: RankedKey[] = [];
  let probed = false;
  for (const [slotRank, slot] of slots.entries()) {
    let names: Buffer[];
    try {
      names = (await client.callBuffer(
        'CLUSTER',
        'GETKEYSINSLOT',
        slot,
        HOT_KEY_NAMES_PER_SLOT,
      )) as Buffer[];
    } catch (error) {
      const note = keysInSlotRefusal(error);
      if (note === undefined) throw error;
      return hotKeysUnavailable(note);
    }
    const batches = probed ? [names] : [names.slice(0, 1), names.slice(1)];
    for (const batch of batches) {
      if (batch.length === 0) continue;
      probed = true;
      const pipeline = client.pipeline();
      for (const name of batch) pipeline.call('OBJECT', 'FREQ', name);
      const replies = (await pipeline.exec()) ?? [];
      for (const [index, name] of batch.entries()) {
        const [error, freq] = replies[index] ?? [null, null];
        if (error) {
          if (SLOT_MOVED.test(error.message)) continue;
          const note = objectFreqRefusal(error);
          if (note === undefined) throw error;
          return hotKeysUnavailable(note);
        }
        if (typeof freq !== 'number') continue;
        read.push({ key: name.toString('utf8'), slot, freq, slotRank });
      }
    }
  }
  return {
    keySource: 'lfu',
    keysSampled: read.length,
    topKeys: read
      .sort(hotterFirst)
      .slice(0, HOT_KEY_TOP)
      .map(({ key, slot, freq }) => ({ key, slot, freq })),
  };
}

export function displayKeyName(name: string): string {
  const points = Array.from(name);
  const cut = points.length > HOT_KEY_NAME_LIMIT;
  const kept = cut ? points.slice(0, HOT_KEY_NAME_LIMIT).join('') : name;
  const shown = kept.replace(UNSAFE_IN_DISPLAY, (char) => {
    if (char === '"' || char === '\\') return `\\${char}`;
    const code = char.codePointAt(0) ?? 0;
    const hex = code.toString(16);
    return code < 0x100 ? `\\x${hex.padStart(2, '0')}` : `\\u{${hex}}`;
  });
  return cut ? `${shown}…` : shown;
}

export function describeHotKeys(keys: readonly HotShardKey[]): string {
  const listed = keys.slice(0, MESSAGE_KEYS);
  if (listed.length === 0) return '';
  const names = listed.map(({ key, freq }) => `"${displayKeyName(key)}" (freq ${freq})`);
  return ` Hot keys: ${names.join(', ')}.`;
}

export function describeMissingKeys(keyNote: string | undefined): string {
  const reason = SHORT_NOTES.find(([pattern]) => pattern.test(keyNote ?? ''))?.[1];
  return (
    ` Key names are not available${reason ? ` (${reason})` : ''}; ` +
    'a capture on this primary can show them.'
  );
}
