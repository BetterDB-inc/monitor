import { displayKeyName } from '@betterdb/shared';
import { type HotKeyReader, readSlotNames } from './hot-shard-keys';

export const HASH_TAG_SLOTS = 3;
export const HASH_TAG_NAMES_PER_SLOT = 500;
export const HASH_TAG_MIN_SHARE = 0.5;
export const HASH_TAG_MIN_KEYS = 2;
export const KEY_COUNT_OUTLIER_FACTOR = 20;
export const KEY_COUNT_OUTLIERS = 10;

const MESSAGE_ITEMS = 3;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;

export type HashTagReader = Pick<HotKeyReader, 'callBuffer'>;

export interface HashTagShare {
  slot: number;
  tag: string;
  share: number;
  keysSampled: number;
  keysWithTag: number;
}

export interface HashTagRead {
  tags: HashTagShare[];
  slotsSampled: number;
  note?: string;
}

export interface KeyCountOutlier {
  slot: number;
  keyCount: number;
  ratio: number;
}

export interface SlotKeyCount {
  slot: number;
  keyCount: number;
}

export interface HashTagAdvice extends HashTagRead {
  keyCountOutliers: KeyCountOutlier[];
  medianKeyCount: number;
  sampledAt?: number;
}

export function hashTagsUnavailable(note: string): HashTagRead {
  return { tags: [], slotsSampled: 0, note };
}

export function hashTagOf(name: Buffer | string): string | null {
  const bytes = typeof name === 'string' ? Buffer.from(name) : name;
  const open = bytes.indexOf(OPEN_BRACE);
  if (open < 0) return null;
  const close = bytes.indexOf(CLOSE_BRACE, open + 1);
  if (close <= open + 1) return null;
  return bytes.subarray(open + 1, close).toString('utf8');
}

export function judgeSlotTag(
  slot: number,
  names: ReadonlyArray<Buffer | string>,
): HashTagShare | null {
  if (names.length === 0) return null;
  const counts = new Map<string, number>();
  for (const name of names) {
    const tag = hashTagOf(name);
    if (tag !== null) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  let best: [string, number] | undefined;
  for (const entry of [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  if (!best || best[1] < HASH_TAG_MIN_KEYS || best[1] / names.length < HASH_TAG_MIN_SHARE) {
    return null;
  }
  return {
    slot,
    tag: best[0],
    share: best[1] / names.length,
    keysSampled: names.length,
    keysWithTag: best[1],
  };
}

export function hashTagsOfNames(names: ReadonlyMap<number, ReadonlyArray<Buffer>>): HashTagRead {
  const tags: HashTagShare[] = [];
  for (const [slot, slotNames] of names) {
    const shared = judgeSlotTag(slot, slotNames);
    if (shared) tags.push(shared);
  }
  return { tags, slotsSampled: names.size };
}

export async function sampleHashTags(
  client: HashTagReader,
  slots: readonly number[],
): Promise<HashTagRead> {
  const read = await readSlotNames(client, slots);
  return read.note === undefined ? hashTagsOfNames(read.names) : hashTagsUnavailable(read.note);
}

export function keyCountOutliers(
  slots: readonly SlotKeyCount[],
  medianKeyCount: number,
): KeyCountOutlier[] {
  const floor = Math.max(medianKeyCount, 1);
  return slots
    .filter((slot) => slot.keyCount >= floor * KEY_COUNT_OUTLIER_FACTOR)
    .sort((a, b) => b.keyCount - a.keyCount || a.slot - b.slot)
    .slice(0, KEY_COUNT_OUTLIERS)
    .map((slot) => ({ slot: slot.slot, keyCount: slot.keyCount, ratio: slot.keyCount / floor }));
}

function listed(values: readonly string[]): string {
  if (values.length < 2) return values.join('');
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
}

function describeTags(tags: readonly HashTagShare[]): string {
  const shown = tags.slice(0, MESSAGE_ITEMS);
  if (shown.length === 0) return '';
  const sentences = shown.map(
    (each) =>
      ` ${Math.round(each.share * 100)}% of the sampled keys in slot ${each.slot} ` +
      `share the hash tag {${displayKeyName(each.tag)}}.`,
  );
  const split = shown.length === 1 ? 'that tag' : 'those tags';
  return `${sentences.join('')} Splitting ${split} in the application spreads them across slots.`;
}

function describeOutliers(outliers: readonly KeyCountOutlier[]): string {
  const shown = outliers.slice(0, MESSAGE_ITEMS);
  if (shown.length === 0) return '';
  const times = (ratio: number) => `${Math.round(ratio)}x`;
  if (shown.length === 1) {
    const [only] = shown;
    return ` Slot ${only.slot} holds ${only.keyCount} keys, ${times(only.ratio)} the median slot.`;
  }
  const slots = shown.map((each) => `${each.slot} (${each.keyCount} keys, ${times(each.ratio)})`);
  return ` Slots ${listed(slots)} each hold at least ${KEY_COUNT_OUTLIER_FACTOR}x the median slot.`;
}

export function describeHashTags(advice: HashTagAdvice | undefined): string {
  if (!advice) return '';
  return describeTags(advice.tags) + describeOutliers(advice.keyCountOutliers);
}
