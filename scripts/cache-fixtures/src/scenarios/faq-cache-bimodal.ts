import { SemanticCache } from '@betterdb/semantic-cache';
import {
  createValkeyClient,
  flushCacheNamespace,
  publishDiscoveryMarker,
} from '../util/valkey.js';
import { generateFaqPrompts } from '../data/faq-prompts.js';
import type { Scenario, ScenarioContext, ScenarioResult } from '../types.js';

const PER_TOPIC_DEFAULT = Number(process.env.FAQ_PER_TOPIC ?? '100');
const DEFAULT_THRESHOLD = 0.1;

async function run(ctx: ScenarioContext): Promise<ScenarioResult> {
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
    defaultThreshold: DEFAULT_THRESHOLD,
  });
  await cache.initialize();

  await client.hset(`${ctx.cacheName}:__config`, 'threshold', String(DEFAULT_THRESHOLD));
  await publishDiscoveryMarker(client, ctx.cacheName, {
    type: 'semantic_cache',
    prefix: ctx.cacheName,
    capabilities: ['threshold_adjust', 'invalidate'],
  });

  const perTopic = PER_TOPIC_DEFAULT;
  const prompts = generateFaqPrompts(perTopic);
  let stored = 0;
  for (const p of prompts) {
    await cache.store(p.prompt, p.response, {
      category: p.category,
      model: 'gpt-4o-mini',
      inputTokens: 40,
      outputTokens: 60,
    });
    stored += 1;
  }

  await client.quit();

  return {
    entries: stored,
    details: {
      perTopic,
      threshold: DEFAULT_THRESHOLD,
      categories: ['billing', 'support'],
    },
  };
}

export const faqCacheBimodal: Scenario = {
  id: 'faq-cache-bimodal',
  description:
    'Semantic-cache populated with billing + support FAQ prompts (bimodal embedding distribution). Drives the threshold-tuning dogfood walkthrough.',
  cacheKind: 'semantic',
  defaultCacheName: 'faq-cache',
  run,
};
