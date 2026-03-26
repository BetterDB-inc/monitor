import type Valkey from 'iovalkey';

export interface SampledKey {
  key: string;
  type: string;
}

/**
 * SCAN each client up to maxKeysPerNode, pipeline TYPE in batches of 1000.
 * Returns combined list of sampled keys with types.
 */
export async function sampleKeyTypes(
  clients: Valkey[],
  maxKeysPerNode: number,
  onProgress?: (scannedSoFar: number) => void,
): Promise<SampledKey[]> {
  const allKeys: SampledKey[] = [];

  for (const client of clients) {
    const nodeKeys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await client.scan(cursor, 'COUNT', 1000);
      cursor = nextCursor;
      for (const k of keys) {
        if (nodeKeys.length >= maxKeysPerNode) break;
        nodeKeys.push(k);
      }
      onProgress?.(allKeys.length + nodeKeys.length);
    } while (cursor !== '0' && nodeKeys.length < maxKeysPerNode);

    // Pipeline TYPE in batches of 1000
    for (let i = 0; i < nodeKeys.length; i += 1000) {
      const batch = nodeKeys.slice(i, i + 1000);
      const pipeline = client.pipeline();
      for (const key of batch) {
        pipeline.type(key);
      }
      const results = await pipeline.exec();
      if (results) {
        for (let j = 0; j < batch.length; j++) {
          const [err, type] = results[j] ?? [];
          allKeys.push({ key: batch[j], type: err ? 'unknown' : String(type) });
        }
      }
    }
  }

  return allKeys;
}
