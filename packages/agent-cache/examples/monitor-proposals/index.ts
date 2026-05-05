/**
 * BetterDB Monitor — cache_propose_tool_ttl_adjust live demo
 *
 * Shows the full no-restart configuration loop:
 *
 *   1. AgentCache starts with no TTL on the "search" tool (policy-free).
 *   2. Claude + BetterDB MCP observes high hit rates and proposes a TTL:
 *        mcp__betterdb__cache_propose_tool_ttl_adjust({ ... })
 *   3. A human approves the proposal in the Monitor web UI (or via MCP).
 *   4. Monitor's dispatcher writes the new policy to Valkey:
 *        HSET {name}:__tool_policies search '{"ttl":3600}'
 *   5. AgentCache picks up the change on the next refresh tick — no restart.
 *
 * This demo simulates steps 4-5 locally by writing directly to Valkey, so
 * you can see the full cycle without running Monitor itself.
 *
 * Prerequisites:
 *   Valkey (standalone): docker run -d --name valkey -p 6379:6379 valkey/valkey:8
 *   Valkey (with Search): docker run -d --name valkey -p 6399:6379 valkey/valkey:8 --loadmodule /usr/lib/valkey/valkey-search.so
 *
 * Usage:
 *   pnpm install && pnpm start
 */
import Valkey from 'iovalkey';
import { AgentCache } from '@betterdb/agent-cache';

// ── Configuration ────────────────────────────────────────────────────────────

const CACHE_NAME = 'demo_ac';
const TOOL_NAME = 'search';
const NEW_TTL_SECONDS = 3600;
// Short refresh interval so the demo completes quickly.
// Production default is 30 000 ms.
const REFRESH_INTERVAL_MS = 5_000;

const host = process.env.VALKEY_HOST ?? 'localhost';
const port = parseInt(process.env.VALKEY_PORT ?? '6379', 10);

// ── Helpers ──────────────────────────────────────────────────────────────────

function sep(label?: string) {
  if (label) {
    const pad = Math.max(0, 60 - label.length - 4);
    console.log(`\n${'─'.repeat(2)} ${label} ${'─'.repeat(pad)}`);
  } else {
    console.log('─'.repeat(62));
  }
}

function log(msg: string) {
  console.log(`  ${msg}`);
}

async function countdown(seconds: number) {
  process.stdout.write(`  Refresh fires in: `);
  for (let i = seconds; i >= 1; i--) {
    process.stdout.write(`${i}… `);
    await sleep(1000);
  }
  process.stdout.write('\n');
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  BetterDB Monitor — cache_propose_tool_ttl_adjust demo  ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // ── 1. Setup ──────────────────────────────────────────────────────────────
  sep('1 · Setup');

  const client = new Valkey({ host, port });

  // Clean slate: remove any leftover policy from a previous run.
  const policiesKey = `${CACHE_NAME}:__tool_policies`;
  await client.del(policiesKey);
  log(`Cleared ${policiesKey}`);

  const cache = new AgentCache({
    client,
    name: CACHE_NAME,
    configRefresh: { intervalMs: REFRESH_INTERVAL_MS },
  });

  log(`AgentCache "${CACHE_NAME}" created`);
  log(`configRefresh.intervalMs = ${REFRESH_INTERVAL_MS} ms (production default: 30 000 ms)`);

  // ── 2. Normal operation — no TTL policy ───────────────────────────────────
  sep('2 · Normal operation (no TTL policy on "search")');

  // Simulate a tool executor calling store() on each unique invocation.
  const toolArgs1 = { query: 'Paris weather today' };
  const toolArgs2 = { query: 'London weather today' };

  await cache.tool.store(TOOL_NAME, toolArgs1, JSON.stringify({ temp: '22°C', sky: 'sunny' }));
  log(`store: search(${JSON.stringify(toolArgs1)}) → cached`);

  await cache.tool.store(TOOL_NAME, toolArgs2, JSON.stringify({ temp: '15°C', sky: 'cloudy' }));
  log(`store: search(${JSON.stringify(toolArgs2)}) → cached`);

  const hit = await cache.tool.check(TOOL_NAME, toolArgs1);
  log(`check: search(${JSON.stringify(toolArgs1)}) → ${hit.hit ? 'HIT ✓' : 'MISS'}`);

  const initialPolicy = cache.tool.getPolicy(TOOL_NAME);
  log(`\n  tool.getPolicy("${TOOL_NAME}") = ${JSON.stringify(initialPolicy) ?? 'undefined (no TTL applied)'}`);
  log('  Entries stored without EX — they never expire.');

  // ── 3. The Monitor / MCP side ─────────────────────────────────────────────
  sep('3 · Monitor agent proposes a TTL via MCP');

  log('Claude, connected to BetterDB Monitor via MCP, calls:');
  console.log();
  console.log(`  mcp__betterdb__cache_propose_tool_ttl_adjust({`);
  console.log(`    cache_name:      "${CACHE_NAME}",`);
  console.log(`    tool_name:       "${TOOL_NAME}",`);
  console.log(`    new_ttl_seconds: ${NEW_TTL_SECONDS},`);
  console.log(`    reasoning: "search tool hit rate is 89% over 7 days — capping`);
  console.log(`                at 1 h TTL controls memory and keeps data fresh."`);
  console.log(`  })`);
  console.log();
  log('→ Monitor creates a pending proposal (status: pending).');
  log('→ A human reviews it in the Monitor UI and clicks Approve.');
  log('→ Monitor\'s dispatcher applies the proposal immediately.');

  // ── 4. Simulate the dispatcher write ──────────────────────────────────────
  sep('4 · Dispatcher writes to Valkey (simulated)');

  const policyJson = JSON.stringify({ ttl: NEW_TTL_SECONDS });
  // This is the exact call CacheApplyDispatcher.applyAgentToolTtlAdjust() makes:
  await client.hset(policiesKey, TOOL_NAME, policyJson);

  log(`HSET ${policiesKey}`);
  log(`      ${TOOL_NAME} = ${policyJson}`);
  log('');
  log('The running AgentCache process has NOT been restarted.');
  log(`It will pick up the change within ${REFRESH_INTERVAL_MS / 1000} s.`);

  // ── 5. Wait for refresh ───────────────────────────────────────────────────
  sep('5 · Waiting for refresh tick');

  await countdown(REFRESH_INTERVAL_MS / 1000);

  // Give the async tick one more event-loop turn to settle.
  await sleep(200);

  // ── 6. Verify ─────────────────────────────────────────────────────────────
  sep('6 · Verify — policy active without restart');

  const updatedPolicy = cache.tool.getPolicy(TOOL_NAME);
  log(`tool.getPolicy("${TOOL_NAME}") = ${JSON.stringify(updatedPolicy)}`);

  if (updatedPolicy?.ttl === NEW_TTL_SECONDS) {
    log(`✓  TTL updated to ${NEW_TTL_SECONDS} s — change is live.`);
  } else {
    log(`✗  Policy not updated yet (got: ${JSON.stringify(updatedPolicy)})`);
  }

  // New stores now use the TTL.
  const toolArgs3 = { query: 'Tokyo weather today' };
  const key = await cache.tool.store(TOOL_NAME, toolArgs3, JSON.stringify({ temp: '28°C', sky: 'humid' }));
  log(`\n  store: search(${JSON.stringify(toolArgs3)}) → key: ${key}`);

  // Confirm Valkey set the TTL (PTTL > 0 means it will expire).
  const pttl = await client.pttl(key);
  if (pttl > 0) {
    log(`  PTTL on stored key: ${Math.round(pttl / 1000)} s  ✓  (EX ${NEW_TTL_SECONDS} applied)`);
  } else {
    log(`  PTTL: ${pttl}  (negative = key not found or no expiry set)`);
  }

  // ── 7. Stats ──────────────────────────────────────────────────────────────
  sep('7 · Cache stats');

  const stats = await cache.stats();
  log(`LLM:  ${stats.llm.hits} hits / ${stats.llm.misses} misses`);
  log(`Tool: ${stats.tool.hits} hits / ${stats.tool.misses} misses  (${(stats.tool.hitRate * 100).toFixed(0)}% hit rate)`);

  sep();
  log('Done. The full loop ran without a process restart.');
  log('');
  log('In production:');
  log('  • Keep configRefresh.intervalMs at the default 30 000 ms.');
  log('  • Use Monitor\'s MCP tools or web UI to create and approve proposals.');
  log('  • Changes propagate to all running instances within one refresh window.');

  await cache.shutdown();
  await client.quit();
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
