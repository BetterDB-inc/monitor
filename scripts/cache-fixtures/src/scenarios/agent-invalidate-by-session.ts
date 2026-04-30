import { AgentCache } from '@betterdb/agent-cache';
import { createValkeyClient, flushCacheNamespace } from '../util/valkey.js';
import type { Scenario, ScenarioContext, ScenarioResult } from '../types.js';

const SESSIONS = ['sess-alpha', 'sess-bravo', 'sess-charlie'];
const TURNS_PER_SESSION = Number(process.env.AGENT_INVALIDATE_PER_SESSION ?? '40');

async function run(ctx: ScenarioContext): Promise<ScenarioResult> {
  const client = createValkeyClient({
    host: ctx.valkeyHost,
    port: ctx.valkeyPort,
    password: ctx.valkeyPassword,
  });

  await flushCacheNamespace(client, ctx.cacheName);

  const agent = new AgentCache({ client, name: ctx.cacheName });

  const perSession: Record<string, number> = {};
  for (const session of SESSIONS) {
    let count = 0;
    for (let i = 0; i < TURNS_PER_SESSION; i += 1) {
      await agent.session.set(session, `turn:${i}`, JSON.stringify({ role: 'user', content: `turn ${i} for ${session}` }));
      count += 1;
    }
    perSession[session] = count;
  }

  await client.quit();

  return {
    entries: Object.values(perSession).reduce((a, b) => a + b, 0),
    details: { perSession, target_for_invalidation: SESSIONS[0] },
  };
}

export const agentInvalidateBySession: Scenario = {
  id: 'agent-invalidate-by-session',
  description:
    'Agent-cache seeded with conversation turns across 3 sessions. Drives invalidate-by-session integration tests.',
  cacheKind: 'agent',
  defaultCacheName: 'invalidate-by-session',
  run,
};
