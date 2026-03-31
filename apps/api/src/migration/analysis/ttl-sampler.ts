import type Valkey from 'iovalkey';
import type { TtlDistribution } from '@betterdb/shared';

export async function sampleTtls(
  client: Valkey,
  keys: string[],
): Promise<TtlDistribution> {
  const dist: TtlDistribution = {
    noExpiry: 0,
    expiresWithin1h: 0,
    expiresWithin24h: 0,
    expiresWithin7d: 0,
    expiresAfter7d: 0,
    sampledKeyCount: 0,
  };

  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const pipeline = client.pipeline();
    for (const key of batch) {
      pipeline.pttl(key);
    }
    const results = await pipeline.exec();
    if (!results) continue;
    for (const [err, ttl] of results) {
      const ms = err ? -2 : Number(ttl);
      if (ms < 0 && ms !== -1) {
        // ms === -2: key expired between SCAN and PTTL, or pipeline error — skip
        continue;
      }
      dist.sampledKeyCount++;
      if (ms === -1) {
        dist.noExpiry++;
      } else if (ms < 3_600_000) {
        dist.expiresWithin1h++;
      } else if (ms < 86_400_000) {
        dist.expiresWithin24h++;
      } else if (ms < 604_800_000) {
        dist.expiresWithin7d++;
      } else {
        dist.expiresAfter7d++;
      }
    }
  }

  return dist;
}
