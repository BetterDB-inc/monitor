import { classifyKey, isChunkKey, maskKey, siblingKey } from '../key-classifier';

const MODEL = 'Qwen/Qwen2.5-0.5B-Instruct';
const HASH = '9e3779b97f4a7c15';

describe('classifyKey', () => {
  it('parses a single-key layout key from the spike', () => {
    expect(classifyKey(`${MODEL}@1@0@${HASH}@bfloat16`)).toEqual({
      model: MODEL,
      worldSize: 1,
      workerId: 0,
      chunkHash: HASH,
      dtype: 'bfloat16',
      layer: null,
      tagged: false,
      suffix: null,
    });
  });

  it('parses redis:// two-key suffixes without a separator', () => {
    expect(classifyKey(`${MODEL}@1@0@${HASH}@bfloat16kv_bytes`)?.suffix).toBe('kv_bytes');
    expect(classifyKey(`${MODEL}@1@0@${HASH}@bfloat16metadata`)?.suffix).toBe('metadata');
  });

  it('parses layerwise and tagged keys', () => {
    const parsed = classifyKey(`${MODEL}@2@1@${HASH}@float8_e4m3fn@12@k%v`);
    expect(parsed).toMatchObject({ worldSize: 2, workerId: 1, dtype: 'float8_e4m3fn', layer: 12, tagged: true });
  });

  it('accepts model names containing @', () => {
    expect(classifyKey(`org/model@v2@1@0@${HASH}@float16`)?.model).toBe('org/model@v2');
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
  ])('rejects %s', (key) => {
    expect(classifyKey(key)).toBeNull();
  });
});

describe('helpers', () => {
  it('finds the sibling of a two-key chunk', () => {
    const key = `${MODEL}@1@0@${HASH}@bfloat16kv_bytes`;
    expect(siblingKey(key, classifyKey(key)!)).toBe(`${MODEL}@1@0@${HASH}@bfloat16metadata`);
    const single = `${MODEL}@1@0@${HASH}@bfloat16`;
    expect(siblingKey(single, classifyKey(single)!)).toBeNull();
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
