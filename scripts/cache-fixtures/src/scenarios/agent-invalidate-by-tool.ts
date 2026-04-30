import { AgentCache } from '@betterdb/agent-cache';
import { createValkeyClient, flushCacheNamespace } from '../util/valkey.js';
import type { Scenario, ScenarioContext, ScenarioResult } from '../types.js';

const TOOLS = ['classify_intent', 'sentiment_score', 'translate_text'];

async function run(ctx: ScenarioContext): Promise<ScenarioResult> {
  const entriesPerTool = Number(process.env.AGENT_INVALIDATE_PER_TOOL ?? '100');

  const client = createValkeyClient({
    host: ctx.valkeyHost,
    port: ctx.valkeyPort,
    password: ctx.valkeyPassword,
  });

  await flushCacheNamespace(client, ctx.cacheName);

  const agent = new AgentCache({ client, name: ctx.cacheName });

  const perTool: Record<string, number> = {};
  for (const tool of TOOLS) {
    let count = 0;
    for (let i = 0; i < entriesPerTool; i += 1) {
      await agent.tool.store(tool, { i }, JSON.stringify({ tool, i }));
      count += 1;
    }
    perTool[tool] = count;
  }

  await client.quit();

  return {
    entries: Object.values(perTool).reduce((a, b) => a + b, 0),
    details: { perTool, target_for_invalidation: TOOLS[0] },
  };
}

export const agentInvalidateByTool: Scenario = {
  id: 'agent-invalidate-by-tool',
  description:
    'Agent-cache seeded with equal-sized entry sets across 3 tools. Drives invalidate-by-tool integration tests.',
  cacheKind: 'agent',
  defaultCacheName: 'invalidate-by-tool',
  run,
};
