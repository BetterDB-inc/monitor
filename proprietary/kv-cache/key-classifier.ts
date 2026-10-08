export type LmcacheKeySuffix = 'kv_bytes' | 'metadata';

export interface ParsedLmcacheKey {
  model: string;
  worldSize: number;
  workerId: number;
  chunkHash: string;
  dtype: string;
  layer: number | null;
  tagged: boolean;
  suffix: LmcacheKeySuffix | null;
}

export const LMCACHE_DTYPES: readonly string[] = [
  'bfloat16',
  'float16',
  'float32',
  'float8_e4m3fn',
  'float8_e5m2',
  'uint8',
  'int8',
];

export const LMCACHE_SCAN_PATTERN = '*@*@*@*@*';

const KEY_PATTERN = new RegExp(
  `^(?<model>.+)@(?<ws>\\d+)@(?<worker>\\d+)@(?<hash>-?[0-9a-f]+)@(?<dtype>${LMCACHE_DTYPES.join('|')})` +
    '(?:@(?<layer>\\d+))?(?<tag>@k%v)?(?<suffix>kv_bytes|metadata)?$',
);

export function classifyKey(key: string): ParsedLmcacheKey | null {
  const groups = KEY_PATTERN.exec(key)?.groups;
  if (!groups) return null;
  return {
    model: groups.model,
    worldSize: Number(groups.ws),
    workerId: Number(groups.worker),
    chunkHash: groups.hash,
    dtype: groups.dtype,
    layer: groups.layer === undefined ? null : Number(groups.layer),
    tagged: groups.tag !== undefined,
    suffix: (groups.suffix as LmcacheKeySuffix | undefined) ?? null,
  };
}

export function siblingKey(key: string, parsed: ParsedLmcacheKey): string | null {
  if (parsed.suffix === null) return null;
  const other: LmcacheKeySuffix = parsed.suffix === 'kv_bytes' ? 'metadata' : 'kv_bytes';
  return key.slice(0, key.length - parsed.suffix.length) + other;
}

export function isChunkKey(parsed: ParsedLmcacheKey): boolean {
  return parsed.suffix !== 'metadata';
}

export function maskKey(parsed: ParsedLmcacheKey): string {
  return `${parsed.model}@${parsed.worldSize}@${parsed.workerId}@${parsed.chunkHash.slice(0, 8)}…@${parsed.dtype}`;
}
