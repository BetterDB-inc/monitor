export type LmcacheKeySuffix = 'kv_bytes' | 'metadata';

export type LmcacheKeyFormat = 'classic' | 'mp';

export interface ParsedLmcacheKey {
  key: string;
  model: string;
  worldSize: number | null;
  workerId: number;
  chunkHash: string;
  dtype: string;
  layer: number | null;
  tagged: boolean;
  suffix: LmcacheKeySuffix | null;
  format: LmcacheKeyFormat;
}

export const MP_UNKNOWN_DTYPE = 'unknown';

export const LMCACHE_TORCH_DTYPE_STRINGS: readonly string[] = [
  'half',
  'bfloat16',
  'float',
  'double',
  'int8',
  'uint8',
  'int16',
  'int32',
  'int64',
  'bool',
  'fp8_e4m3fn',
  'fp8_e4m3fnuz',
  'fp8_e5m2',
  'fp8_e5m2fnuz',
];

const KEY_PATTERN = new RegExp(
  `^(?<model>.+)@(?<ws>\\d+)@(?<worker>\\d+)@(?<hash>-?[0-9a-f]+)@(?<dtype>${LMCACHE_TORCH_DTYPE_STRINGS.join('|')})` +
    '(?:@(?<layer>\\d+))?(?<tags>(?:@[^@%]+%[^@]*?)*)(?<suffix>kv_bytes|metadata)?$',
);

const MP_KEY_PATTERN =
  /^(?<lead>[^@].*)@(?<rank>[0-9a-f]{8})@(?<group>[0-9a-f]+)@(?<hash>(?:[0-9a-f]{2}){8,})(?:@(?<salt>[^@/\\\0]{1,128}))?$/;

function classifyMpKey(key: string): ParsedLmcacheKey | null {
  const groups = MP_KEY_PATTERN.exec(key)?.groups;
  if (!groups) return null;
  const model = groups.lead.slice(groups.lead.lastIndexOf('@') + 1);
  if (model === '') return null;
  return {
    key,
    model,
    worldSize: null,
    workerId: parseInt(groups.rank, 16),
    chunkHash: groups.hash,
    dtype: MP_UNKNOWN_DTYPE,
    layer: null,
    tagged: false,
    suffix: null,
    format: 'mp',
  };
}

export function classifyKey(key: string): ParsedLmcacheKey | null {
  const groups = KEY_PATTERN.exec(key)?.groups;
  if (!groups) return classifyMpKey(key);
  return {
    key,
    model: groups.model,
    worldSize: Number(groups.ws),
    workerId: Number(groups.worker),
    chunkHash: groups.hash,
    dtype: groups.dtype,
    layer: groups.layer === undefined ? null : Number(groups.layer),
    tagged: groups.tags !== '',
    suffix: (groups.suffix as LmcacheKeySuffix | undefined) ?? null,
    format: 'classic',
  };
}

const isTagOrSuffix = (parsed: ParsedLmcacheKey) => parsed.tagged && parsed.suffix !== null;

export function siblingKey(parsed: ParsedLmcacheKey): string | null {
  if (parsed.suffix === null) return null;
  const other: LmcacheKeySuffix = parsed.suffix === 'kv_bytes' ? 'metadata' : 'kv_bytes';
  return parsed.key.slice(0, parsed.key.length - parsed.suffix.length) + other;
}

export function hasTwoKeyEvidence(keys: ParsedLmcacheKey[]): boolean {
  const present = new Set(keys.map((parsed) => parsed.key));
  return keys.some((parsed) => parsed.suffix !== null && (!parsed.tagged || present.has(siblingKey(parsed) as string)));
}

export function hasSingleKeyEvidence(keys: ParsedLmcacheKey[]): boolean {
  return keys.some((parsed) => parsed.suffix === null);
}

export function resolveTagSuffixes(
  keys: ParsedLmcacheKey[],
  twoKey = hasTwoKeyEvidence(keys),
  singleKey = hasSingleKeyEvidence(keys),
): ParsedLmcacheKey[] {
  if (!singleKey || twoKey) return keys;
  return keys.map((parsed) => (isTagOrSuffix(parsed) ? { ...parsed, suffix: null } : parsed));
}

export function isChunkKey(parsed: ParsedLmcacheKey): boolean {
  return parsed.suffix !== 'metadata';
}

export function maskKey(parsed: ParsedLmcacheKey): string {
  if (parsed.format === 'mp') {
    const groups = MP_KEY_PATTERN.exec(parsed.key)?.groups;
    return `${parsed.model}@${groups?.rank}@${groups?.group}@${parsed.chunkHash.slice(0, 8)}…`;
  }
  return `${parsed.model}@${parsed.worldSize}@${parsed.workerId}@${parsed.chunkHash.slice(0, 8)}…@${parsed.dtype}`;
}
