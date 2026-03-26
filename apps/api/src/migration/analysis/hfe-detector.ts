import type Valkey from 'iovalkey';

export interface HfeResult {
  hfeDetected: boolean;
  hfeSupported: boolean;
  hfeKeyCount: number;
  hfeOversizedHashesSkipped: number;
  sampledHashCount: number;
}

const MAX_HASH_SAMPLE = 300;
const MAX_HASH_FIELDS = 10_000;

export async function detectHfe(
  client: Valkey,
  hashKeys: string[],
  totalEstimatedHashKeys: number,
): Promise<HfeResult> {
  const result: HfeResult = {
    hfeDetected: false,
    hfeSupported: true,
    hfeKeyCount: 0,
    hfeOversizedHashesSkipped: 0,
    sampledHashCount: 0,
  };

  const candidates = hashKeys.slice(0, MAX_HASH_SAMPLE);
  if (candidates.length === 0) {
    return result;
  }

  // Check HLEN for each candidate, skip oversized ones
  const validKeys: string[] = [];
  for (let i = 0; i < candidates.length; i += 1000) {
    const batch = candidates.slice(i, i + 1000);
    const pipeline = client.pipeline();
    for (const key of batch) {
      pipeline.hlen(key);
    }
    const results = await pipeline.exec();
    if (!results) continue;
    for (let j = 0; j < batch.length; j++) {
      const [err, len] = results[j] ?? [];
      if (err || Number(len) > MAX_HASH_FIELDS) {
        result.hfeOversizedHashesSkipped++;
      } else {
        validKeys.push(batch[j]);
      }
    }
  }

  if (validKeys.length === 0) {
    result.sampledHashCount = 0;
    return result;
  }

  // HRANDFIELD to get up to 3 random fields per key
  const keyFieldPairs: Array<{ key: string; field: string }> = [];
  for (let i = 0; i < validKeys.length; i += 1000) {
    const batch = validKeys.slice(i, i + 1000);
    const pipeline = client.pipeline();
    for (const key of batch) {
      pipeline.call('HRANDFIELD', key, '-3');
    }
    const results = await pipeline.exec();
    if (!results) continue;
    for (let j = 0; j < batch.length; j++) {
      const [err, fields] = results[j] ?? [];
      if (err || !fields) continue;
      const fieldList = Array.isArray(fields) ? fields : [fields];
      for (const f of fieldList) {
        keyFieldPairs.push({ key: batch[j], field: String(f) });
      }
    }
  }

  result.sampledHashCount = validKeys.length;

  if (keyFieldPairs.length === 0) {
    return result;
  }

  // Pipeline HEXPIRETIME — wrap in try/catch for Redis (unknown command)
  try {
    let hfePositiveKeys = 0;
    const checkedKeys = new Set<string>();

    const pipeline = client.pipeline();
    for (const { key, field } of keyFieldPairs) {
      pipeline.call('HEXPIRETIME', key, 'FIELDS', '1', field);
    }
    const results = await pipeline.exec();
    if (results) {
      for (let i = 0; i < keyFieldPairs.length; i++) {
        const [err, val] = results[i] ?? [];
        if (err) {
          // If the error indicates unknown command, HFE not supported
          const errMsg = String(err);
          if (errMsg.includes('unknown command') || errMsg.includes('ERR')) {
            result.hfeSupported = false;
            result.hfeDetected = false;
            return result;
          }
          continue;
        }
        // HEXPIRETIME returns an array with the expiry time, >0 means HFE in use
        const expiry = Array.isArray(val) ? Number(val[0]) : Number(val);
        if (expiry > 0 && !checkedKeys.has(keyFieldPairs[i].key)) {
          checkedKeys.add(keyFieldPairs[i].key);
          hfePositiveKeys++;
        }
      }
    }

    if (hfePositiveKeys > 0) {
      result.hfeDetected = true;
      result.hfeKeyCount = validKeys.length > 0
        ? Math.round((hfePositiveKeys / validKeys.length) * totalEstimatedHashKeys)
        : 0;
    }
  } catch {
    // HEXPIRETIME not supported (Redis)
    result.hfeSupported = false;
    result.hfeDetected = false;
  }

  return result;
}
