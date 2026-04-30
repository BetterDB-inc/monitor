import { SemanticCache } from '@betterdb/semantic-cache';
import {
  createValkeyClient,
  flushCacheNamespace,
  publishDiscoveryMarker,
} from '../util/valkey.js';
import type { Scenario, ScenarioContext, ScenarioResult } from '../types.js';

const TARGET_MODEL = 'gpt-4o-mini';
const OTHER_MODEL = 'gpt-4o';
const TARGET_RATIO = 0.6;

async function run(ctx: ScenarioContext): Promise<ScenarioResult> {
  const total = Number(process.env.SEMANTIC_INVALIDATE_TOTAL ?? '500');

  const client = createValkeyClient({
    host: ctx.valkeyHost,
    port: ctx.valkeyPort,
    password: ctx.valkeyPassword,
  });

  await flushCacheNamespace(client, ctx.cacheName);

  const cache = new SemanticCache({
    client,
    embedFn: ctx.embedFn,
    name: ctx.cacheName,
    defaultThreshold: 0.1,
  });
  await cache.initialize();

  await publishDiscoveryMarker(client, ctx.cacheName, {
    type: 'semantic_cache',
    prefix: ctx.cacheName,
    capabilities: ['threshold_adjust', 'invalidate'],
  });

  const targetCount = Math.floor(total * TARGET_RATIO);
  let stored = 0;
  for (let i = 0; i < total; i += 1) {
    const isTarget = i < targetCount;
    await cache.store(`Distinct prompt number ${i}`, `Response ${i}`, {
      model: isTarget ? TARGET_MODEL : OTHER_MODEL,
      category: isTarget ? 'group-a' : 'group-b',
    });
    stored += 1;
  }

  await client.quit();

  return {
    entries: stored,
    details: {
      total,
      target_model: TARGET_MODEL,
      target_count: targetCount,
      other_model: OTHER_MODEL,
      other_count: total - targetCount,
    },
  };
}

export const semanticInvalidateByModel: Scenario = {
  id: 'semantic-invalidate-by-model',
  description:
    'Semantic-cache with 500 entries across two models. Drives semantic-cache invalidate-by-model integration tests.',
  cacheKind: 'semantic',
  defaultCacheName: 'invalidate-by-model',
  run,
};
