import { classifyKey, isChunkKey, maskKey, resolveTagSuffixes, siblingKey } from '../key-classifier';

const MODEL = 'Qwen/Qwen2.5-0.5B-Instruct';
const HASH = '9e3779b97f4a7c15';

describe('classifyKey', () => {
  it('parses a single-key layout key from the spike', () => {
    expect(classifyKey(`${MODEL}@1@0@${HASH}@bfloat16`)).toEqual({
      key: `${MODEL}@1@0@${HASH}@bfloat16`,
      model: MODEL,
      worldSize: 1,
      workerId: 0,
      chunkHash: HASH,
      dtype: 'bfloat16',
      layer: null,
      tagged: false,
      suffix: null,
      format: 'classic',
    });
  });

  it('parses redis:// two-key suffixes without a separator', () => {
    expect(classifyKey(`${MODEL}@1@0@${HASH}@bfloat16kv_bytes`)?.suffix).toBe('kv_bytes');
    expect(classifyKey(`${MODEL}@1@0@${HASH}@bfloat16metadata`)?.suffix).toBe('metadata');
  });

  it('parses layerwise and tagged keys', () => {
    const parsed = classifyKey(`${MODEL}@2@1@${HASH}@fp8_e4m3fn@12@k%v`);
    expect(parsed).toMatchObject({ worldSize: 2, workerId: 1, dtype: 'fp8_e4m3fn', layer: 12, tagged: true });
  });

  it.each([
    ['half'],
    ['float'],
    ['double'],
    ['bfloat16'],
    ['int8'],
    ['uint8'],
    ['int16'],
    ['int32'],
    ['int64'],
    ['bool'],
    ['fp8_e4m3fn'],
    ['fp8_e4m3fnuz'],
    ['fp8_e5m2'],
    ['fp8_e5m2fnuz'],
  ])('accepts the LMCache dtype string %s', (dtype) => {
    expect(classifyKey(`${MODEL}@1@0@${HASH}@${dtype}`)?.dtype).toBe(dtype);
  });

  it.each([['float16'], ['float32'], ['float64'], ['float8_e4m3fn'], ['float8_e5m2']])(
    'rejects the torch attribute name %s',
    (dtype) => {
      expect(classifyKey(`${MODEL}@1@0@${HASH}@${dtype}`)).toBeNull();
    },
  );

  it.each([
    ['@user%alice', null],
    ['@user%alice@tenant%acme', null],
    ['@user%alice@tenant%acme@session%a%b', null],
    ['@user%', null],
    ['@user%alice', 'kv_bytes'],
    ['@user%alice', 'metadata'],
    ['@user%alice@tenant%acme', 'kv_bytes'],
    ['@user%alice@tenant%acme', 'metadata'],
  ])('parses arbitrary tags %s with suffix %s', (tags, suffix) => {
    const key = `${MODEL}@1@0@${HASH}@half${tags}${suffix ?? ''}`;
    expect(classifyKey(key)).toMatchObject({ dtype: 'half', layer: null, tagged: true, suffix });
  });

  it.each([
    ['@user%alice', null],
    ['@user%alice@tenant%acme', null],
    ['@user%alice', 'kv_bytes'],
    ['@user%alice@tenant%acme', 'metadata'],
    ['', 'kv_bytes'],
  ])('parses layered keys with tags %s and suffix %s', (tags, suffix) => {
    const key = `${MODEL}@2@1@${HASH}@bfloat16@7${tags}${suffix ?? ''}`;
    expect(classifyKey(key)).toMatchObject({ layer: 7, tagged: tags !== '', suffix });
  });

  it('pairs tagged two-key siblings', () => {
    const key = `${MODEL}@1@0@${HASH}@half@user%alice@tenant%acmekv_bytes`;
    expect(siblingKey(classifyKey(key)!)).toBe(`${MODEL}@1@0@${HASH}@half@user%alice@tenant%acmemetadata`);
  });

  it('accepts model names containing @', () => {
    expect(classifyKey(`org/model@v2@1@0@${HASH}@half@user%alice`)?.model).toBe('org/model@v2');
  });

  it('accepts a negative hash', () => {
    expect(classifyKey(`${MODEL}@1@0@-1a2b@int8`)?.chunkHash).toBe('-1a2b');
  });

  it.each([
    [`${MODEL}@1@0@XYZ@bfloat16`],
    [`${MODEL}@1@0@${HASH}@float64`],
    [`${MODEL}@one@0@${HASH}@bfloat16`],
    [`user:1@a@b@c@d`],
    [`@1@0@${HASH}@bfloat16`],
    [`${MODEL}@1@0@${HASH}@bfloat16extra`],
    [`${MODEL}@1@0@${HASH}@half@user`],
    [`${MODEL}@1@0@${HASH}@half@%alice`],
    [`${MODEL}@1@0@${HASH}@half@user%alice@`],
  ])('rejects %s', (key) => {
    expect(classifyKey(key)).toBeNull();
  });
});

describe('classifyKey with the multiprocess Valkey L2 adapter format', () => {
  const MP_HASH = 'a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const mp = `${MODEL}@00000003@0@${MP_HASH}`;

  it('parses an unsalted chunk object key', () => {
    expect(classifyKey(mp)).toEqual({
      key: mp,
      model: MODEL,
      worldSize: null,
      workerId: 3,
      chunkHash: MP_HASH,
      dtype: 'unknown',
      layer: null,
      tagged: false,
      suffix: null,
      format: 'mp',
    });
  });

  it('parses a salted key and a key_prefix', () => {
    expect(classifyKey(`${mp}@tenant-a`)).toMatchObject({ model: MODEL, chunkHash: MP_HASH, format: 'mp' });
    expect(classifyKey(`lmc@${MODEL}@0000000a@1f@${MP_HASH}`)).toMatchObject({
      model: MODEL,
      workerId: 10,
      chunkHash: MP_HASH,
    });
    expect(classifyKey(`lmc@${MODEL}@00000000@0@${MP_HASH}@salt`)).toMatchObject({ model: MODEL, format: 'mp' });
  });

  it('counts each object key as a single-key chunk with no sibling', () => {
    const parsed = classifyKey(mp)!;
    expect(isChunkKey(parsed)).toBe(true);
    expect(siblingKey(parsed)).toBeNull();
  });

  it('masks the hash', () => {
    expect(maskKey(classifyKey(`lmc@${mp}@salt`)!)).toBe(`${MODEL}@00000003@0@a3f1c2d4…`);
  });

  it.each([
    [`${MODEL}@3@0@${MP_HASH}`],
    [`${MODEL}@0000000g@0@${MP_HASH}`],
    [`${MODEL}@00000003@0@abc`],
    [`${MODEL}@00000003@0@${MP_HASH}0`],
    [`${MODEL}@00000003@@${MP_HASH}`],
    [`${MODEL}@00000003@0@${MP_HASH}@`],
    [`${MODEL}@00000003@0@${MP_HASH}@a/b`],
    [`@00000003@0@${MP_HASH}`],
    [`user@00000001@1@ab`],
  ])('rejects %s', (key) => {
    expect(classifyKey(key)).toBeNull();
  });

  it('keeps classifying classic keys as classic', () => {
    expect(classifyKey(`${MODEL}@1@0@${HASH}@bfloat16`)?.format).toBe('classic');
    expect(classifyKey(`${MODEL}@1@0@${MP_HASH}@half`)?.format).toBe('classic');
    expect(classifyKey(`${MODEL}@1@0@${HASH}@half@user%alice`)?.format).toBe('classic');
  });
});

describe('helpers', () => {
  it('finds the sibling of a two-key chunk', () => {
    const key = `${MODEL}@1@0@${HASH}@bfloat16kv_bytes`;
    expect(siblingKey(classifyKey(key)!)).toBe(`${MODEL}@1@0@${HASH}@bfloat16metadata`);
    const single = `${MODEL}@1@0@${HASH}@bfloat16`;
    expect(siblingKey(classifyKey(single)!)).toBeNull();
  });

  it('counts kv_bytes and single keys as chunks but not metadata', () => {
    expect(isChunkKey(classifyKey(`${MODEL}@1@0@${HASH}@bfloat16`)!)).toBe(true);
    expect(isChunkKey(classifyKey(`${MODEL}@1@0@${HASH}@bfloat16kv_bytes`)!)).toBe(true);
    expect(isChunkKey(classifyKey(`${MODEL}@1@0@${HASH}@bfloat16metadata`)!)).toBe(false);
  });

  it('masks the hash', () => {
    expect(maskKey(classifyKey(`${MODEL}@1@0@${HASH}@bfloat16`)!)).toBe(`${MODEL}@1@0@9e3779b9…@bfloat16`);
  });
});

describe('resolveTagSuffixes', () => {
  const tagged = (i: number, tail: string) => classifyKey(`${MODEL}@1@0@${i}@half@kind%${tail}`)!;

  it('reads a tag value ending in a suffix name as the tag when the node stores single keys', () => {
    const [ambiguous, plain] = resolveTagSuffixes([tagged(1, 'metadata'), tagged(2, 'prefill')]);
    expect(ambiguous).toMatchObject({ suffix: null, tagged: true, key: `${MODEL}@1@0@1@half@kind%metadata` });
    expect(plain.suffix).toBeNull();
  });

  it('keeps the suffix when the node stores two keys per chunk', () => {
    const untagged = classifyKey(`${MODEL}@1@0@3@halfkv_bytes`)!;
    const keys = [tagged(1, 'metadata'), tagged(2, 'prefill'), untagged];
    expect(resolveTagSuffixes(keys)[0].suffix).toBe('metadata');
  });

  it('keeps tagged two-key pairs on a mixed node that also stores single keys', () => {
    const keys = [tagged(3, 'prefillkv_bytes'), tagged(3, 'prefillmetadata'), tagged(4, 'decode')];
    expect(resolveTagSuffixes(keys).map((k) => k.suffix)).toEqual(['kv_bytes', 'metadata', null]);
  });

  it('keeps an unpaired tagged suffix when a tagged pair shows the node stores two keys', () => {
    const keys = [tagged(1, 'metadata'), tagged(3, 'prefillkv_bytes'), tagged(3, 'prefillmetadata'), tagged(4, 'decode')];
    expect(resolveTagSuffixes(keys)[0].suffix).toBe('metadata');
  });

  it('reads tag values as tags when single-key evidence comes from another node', () => {
    expect(resolveTagSuffixes([tagged(1, 'metadata'), tagged(2, 'kv_bytes')], false, true).map((k) => k.suffix)).toEqual([
      null,
      null,
    ]);
  });

  it('keeps the suffix when the run has no single-key evidence even if the node does', () => {
    expect(resolveTagSuffixes([tagged(1, 'metadata'), tagged(2, 'prefill')], false, false)[0].suffix).toBe('metadata');
  });

  it('keeps the suffix when nothing on the node breaks the tie', () => {
    expect(resolveTagSuffixes([tagged(1, 'metadata'), tagged(2, 'kv_bytes')]).map((k) => k.suffix)).toEqual([
      'metadata',
      'kv_bytes',
    ]);
  });
});
