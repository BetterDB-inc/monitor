import { AgentCache } from '@betterdb/agent-cache';
import { createValkeyClient, flushCacheNamespace } from '../util/valkey.js';
import type { Scenario, ScenarioContext, ScenarioResult } from '../types.js';

interface ToolSeed {
  toolName: string;
  ttl: number;
  argsList: unknown[];
  responseBuilder: (args: unknown) => string;
}

const TOOLS: ToolSeed[] = [
  {
    toolName: 'weather_lookup',
    ttl: 60,
    argsList: ['London', 'New York', 'Tokyo', 'Sofia', 'Berlin', 'Paris', 'Sydney', 'Delhi'].map(
      (city) => ({ city }),
    ),
    responseBuilder: (args) => JSON.stringify({ city: (args as { city: string }).city, temp_c: 18 }),
  },
  {
    toolName: 'classify_intent',
    ttl: 300,
    argsList: Array.from({ length: 40 }, (_, i) => ({ utterance: `intent sample ${i}` })),
    responseBuilder: (args) =>
      JSON.stringify({ intent: 'support', utterance: (args as { utterance: string }).utterance }),
  },
  {
    toolName: 'lookup_user',
    ttl: 600,
    argsList: Array.from({ length: 25 }, (_, i) => ({ userId: `user_${i}` })),
    responseBuilder: (args) =>
      JSON.stringify({ id: (args as { userId: string }).userId, plan: 'pro' }),
  },
];

async function run(ctx: ScenarioContext): Promise<ScenarioResult> {
  const client = createValkeyClient({
    host: ctx.valkeyHost,
    port: ctx.valkeyPort,
    password: ctx.valkeyPassword,
  });

  await flushCacheNamespace(client, ctx.cacheName);

  const agent = new AgentCache({ client, name: ctx.cacheName });

  let stored = 0;
  const perTool: Record<string, number> = {};
  for (const tool of TOOLS) {
    await agent.tool.setPolicy(tool.toolName, { ttl: tool.ttl });
    let toolStored = 0;
    for (const args of tool.argsList) {
      await agent.tool.store(tool.toolName, args, tool.responseBuilder(args));
      toolStored += 1;
    }
    perTool[tool.toolName] = toolStored;
    stored += toolStored;
  }

  await client.quit();

  return {
    entries: stored,
    details: {
      perTool,
      policies: Object.fromEntries(TOOLS.map((t) => [t.toolName, { ttl: t.ttl }])),
    },
  };
}

export const prodAgentThreeTools: Scenario = {
  id: 'prod-agent-three-tools',
  description:
    'Agent-cache with three tools (weather_lookup TTL 60, classify_intent TTL 300, lookup_user TTL 600). Drives the tool-TTL-tuning and invalidate-by-tool walkthroughs.',
  cacheKind: 'agent',
  defaultCacheName: 'prod-agent',
  run,
};
