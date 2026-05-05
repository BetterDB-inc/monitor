/**
 * BetterDB Monitor — cache_propose_threshold_adjust live demo
 *
 * Shows the full no-restart configuration loop:
 *
 *   1. SemanticCache starts with a loose threshold (0.25) — borderline queries hit.
 *   2. Claude + BetterDB MCP reviews the similarity distribution and proposes a tighten:
 *        mcp__betterdb__cache_propose_threshold_adjust({ ... })
 *   3. A human approves the proposal in the Monitor web UI (or via MCP).
 *   4. Monitor's dispatcher writes the new threshold to Valkey:
 *        HSET {name}:__config threshold "0.10"
 *   5. SemanticCache picks up the change on the next refresh tick — no restart.
 *   6. The same borderline queries that were hits at 0.25 become misses at 0.10.
 *
 * This demo simulates steps 4-5 locally by writing directly to Valkey, so
 * you can see the full cycle without running Monitor itself.
 *
 * No API key required — uses a deterministic content-word embedder.
 *
 * Embedder geometry (why the distances are what they are):
 *   - Stopwords (is, the, what, of, …) are filtered before building the vector.
 *   - Each unique content word maps to a fixed dimension via DJB2 hash (dim=64).
 *   - A prompt with N content words becomes a unit vector with 1/√N at those positions.
 *   - Prompts sharing K out of their content words have cosine similarity K/√(N1·N2).
 *   - So "capital france" (N=2) vs "capital france city" (N=3):
 *       similarity = 2/√(2·3) = √(2/3) ≈ 0.816  →  distance ≈ 0.184
 *   - "pizza topping best" vs anything cached:
 *       similarity = 0  →  distance = 1.000 (no shared content words)
 *
 * Prerequisites:
 *   Valkey with valkey-search module at localhost:6399:
 *     docker run -d --name valkey -p 6399:6379 valkey/valkey:8 \
 *       --loadmodule /usr/lib/valkey/valkey-search.so
 *
 * Usage:
 *   pnpm install && pnpm start
 */
import Valkey from 'iovalkey';
import { SemanticCache } from '@betterdb/semantic-cache';

// ── Configuration ────────────────────────────────────────────────────────────

const CACHE_NAME = 'demo_sc';
// Loose enough for borderline queries to hit; tight enough for genuine misses.
const INITIAL_THRESHOLD = 0.25;
// Tighter: borderline queries (distance ≈ 0.184) will now miss.
const NEW_THRESHOLD = 0.10;
// Short refresh so the demo completes quickly.
// Production default is 30 000 ms.
const REFRESH_INTERVAL_MS = 5_000;

const host = process.env.VALKEY_HOST ?? 'localhost';
const port = parseInt(process.env.VALKEY_PORT ?? '6399', 10);

// ── Mock embedder ─────────────────────────────────────────────────────────────
//
// Content-word-only word-overlap embedder with DJB2 hashing (dim=64).
//
// Filtering stopwords means:
//   • "What is the capital of France?" and "capital France" share the SAME
//     content words → cosine distance ≈ 0 (guaranteed hit at any threshold).
//   • "What is France's capital city?" has content words [france, capital, city].
//     Two of three match [capital, france] → distance = 1 - 2/√6 ≈ 0.184.
//     This sits between 0.10 and 0.25, so it's threshold-sensitive.
//   • "What is the best pizza topping?" has content words [best, pizza, topping].
//     Zero overlap with anything cached → distance = 1.0 (definite miss).
//
const STOPWORDS = new Set([
  'what', 'is', 'the', 'a', 'an', 'of', 'in', 'who', 'how', 'where',
  'when', 'why', 'that', 'this', 'it', 'are', 'was', 'were', 'be', 'been',
  'do', 'does', 'did', 'i', 'you', 'we', 'they', 'he', 'she',
  'at', 'as', 'for', 'by', 'and', 'or', 'not', 's',
]);

function mockEmbed(text: string): Promise<number[]> {
  const dim = 64;
  // Deduplicated content words only.
  const words = [...new Set(
    text.toLowerCase().split(/\W+/).filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  )];

  const vec = new Array<number>(dim).fill(0);
  for (const word of words) {
    // DJB2 hash → stable dimension index.
    let h = 5381;
    for (let i = 0; i < word.length; i++) {
      h = ((h << 5) + h + word.charCodeAt(i)) >>> 0;
    }
    vec[h % dim] += 1;
  }

  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return Promise.resolve(vec.map((x) => x / norm));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sep(label?: string) {
  if (label) {
    const pad = Math.max(0, 60 - label.length - 4);
    console.log(`\n${'─'.repeat(2)} ${label} ${'─'.repeat(pad)}`);
  } else {
    console.log('─'.repeat(62));
  }
}

function log(msg: string) { console.log(`  ${msg}`); }

async function checkAndLog(
  cache: SemanticCache,
  prompt: string,
  label: string,
  category?: string,
): Promise<{ hit: boolean; similarity?: number; confidence?: string }> {
  const r = await cache.check(prompt, category ? { category } : undefined);
  const score = r.similarity !== undefined ? ` (score: ${r.similarity.toFixed(3)})` : '';
  const conf = r.hit && r.confidence !== 'high' ? ` [${r.confidence}]` : '';
  const outcome = r.hit ? `HIT${conf}` : 'MISS';
  const cat = category ? ` [category: ${category}]` : '';
  log(`${label}: "${prompt.slice(0, 48)}"${cat}  →  ${outcome}${score}`);
  return r;
}

async function countdown(seconds: number) {
  process.stdout.write(`  Refresh fires in: `);
  for (let i = seconds; i >= 1; i--) {
    process.stdout.write(`${i}… `);
    await new Promise<void>((r) => setTimeout(r, 1000));
  }
  process.stdout.write('\n');
}

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  BetterDB Monitor — cache_propose_threshold_adjust demo      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // ── 1. Setup ──────────────────────────────────────────────────────────────
  sep('1 · Setup');

  const client = new Valkey({ host, port });
  const configKey = `${CACHE_NAME}:__config`;
  await client.del(configKey);
  log(`Cleared ${configKey}`);

  const cache = new SemanticCache({
    client,
    name: CACHE_NAME,
    embedFn: mockEmbed,
    defaultThreshold: INITIAL_THRESHOLD,
    uncertaintyBand: 0.05,
    embeddingCache: { enabled: false },
    configRefresh: { intervalMs: REFRESH_INTERVAL_MS },
  });

  await cache.initialize();
  log(`SemanticCache "${CACHE_NAME}" initialized`);
  log(`defaultThreshold      = ${INITIAL_THRESHOLD}  (loose)`);
  log(`configRefresh.interval = ${REFRESH_INTERVAL_MS} ms  (production default: 30 000 ms)`);
  log(`Embedder: content-word overlap — stopwords stripped, DJB2 hash, dim=64`);

  // ── 2. Seed entries ───────────────────────────────────────────────────────
  sep('2 · Seed cache (3 entries)');

  const seeded = [
    // Content words after stopword filtering are shown in brackets.
    { prompt: 'What is the capital of France?',   response: 'Paris'           }, // [capital, france]
    { prompt: 'Who wrote Romeo and Juliet?',       response: 'William Shakespeare' }, // [wrote, romeo, juliet]
    { prompt: 'What is the speed of light?',       response: '299,792 km/s'   }, // [speed, light]
  ];
  for (const { prompt, response } of seeded) {
    await cache.store(prompt, response);
    log(`stored: "${prompt}" → "${response}"`);
  }

  // ── 3. Baseline queries at threshold 0.25 ─────────────────────────────────
  sep(`3 · Baseline queries at threshold ${INITIAL_THRESHOLD}`);
  log(`Content-word distances (predicted):`);
  log(`  exact match         → distance ≈ 0.000  (hit at any threshold)`);
  log(`  +1 extra word       → distance ≈ 0.184  (hit at 0.25, miss at 0.10)`);
  log(`  no shared words     → distance = 1.000  (miss at any threshold)`);
  console.log();

  // Exact match — always a hit.
  await checkAndLog(cache, 'What is the capital of France?', '  check');

  // Borderline — [france, capital, city]: 2 of 2 stored words match + 1 extra.
  // Predicted distance: 1 - 2/√(2·3) = 1 - √(2/3) ≈ 0.184  →  HIT at 0.25.
  const borderline1 = await checkAndLog(cache, "What is France's capital city?", '  check');

  // Borderline — [approximate, speed, light]: 2 of 2 stored words match + 1 extra.
  // Same geometry → distance ≈ 0.184  →  HIT at 0.25.
  const borderline2 = await checkAndLog(cache, 'What is the approximate speed of light?', '  check');

  // Definite miss — [best, pizza, topping]: zero shared content words.
  // distance = 1.0  →  MISS at any threshold.
  await checkAndLog(cache, 'What is the best pizza topping?', '  check');

  const borderlineHits = [borderline1, borderline2].filter((r) => r.hit).length;
  console.log();
  log(`Borderline queries hitting at ${INITIAL_THRESHOLD}: ${borderlineHits}/2`);
  log('These are not wrong answers in this demo, but in production a borderline');
  log('match (score 0.18) is riskier than a tight one (score 0.01) — the operator');
  log('wants to force borderline queries back to the LLM for fresh answers.');

  // ── 4. The Monitor / MCP side ─────────────────────────────────────────────
  sep('4 · Monitor agent proposes a threshold tighten via MCP');

  log('After reviewing cache_similarity_distribution and cache_threshold_recommendation,');
  log('Claude calls:');
  console.log();
  console.log(`  mcp__betterdb__cache_propose_threshold_adjust({`);
  console.log(`    cache_name:    "${CACHE_NAME}",`);
  console.log(`    new_threshold: ${NEW_THRESHOLD},`);
  console.log(`    reasoning: "Two query clusters land at cosine distance ~0.18 —`);
  console.log(`               just inside the 0.25 threshold. Tightening to 0.10`);
  console.log(`               eliminates these borderline matches and forces the LLM`);
  console.log(`               to answer them fresh, improving answer reliability."`);
  console.log(`  })`);
  console.log();
  log('→ Monitor creates a pending proposal  (status: pending).');
  log('→ A human reviews it in the Monitor UI and clicks Approve.');
  log('→ Monitor\'s dispatcher applies the proposal immediately.');

  // ── 5. Simulate the dispatcher write ──────────────────────────────────────
  sep('5 · Dispatcher writes to Valkey (simulated)');

  // Exact call CacheApplyDispatcher.applySemanticThresholdAdjust() makes:
  await client.hset(configKey, 'threshold', String(NEW_THRESHOLD));
  log(`HSET ${configKey}`);
  log(`      threshold = "${NEW_THRESHOLD}"`);
  log('');
  log('The SemanticCache process has NOT been restarted.');
  log(`It will pick up the change on the next refresh tick (${REFRESH_INTERVAL_MS / 1000} s).`);

  // ── 6. Wait for refresh ───────────────────────────────────────────────────
  sep('6 · Waiting for refresh tick');

  await countdown(REFRESH_INTERVAL_MS / 1000);
  await sleep(200);

  // ── 7. Verify threshold updated ───────────────────────────────────────────
  sep('7 · Verify — threshold updated without restart');

  log(`cache._defaultThreshold  before: ${INITIAL_THRESHOLD}`);
  log(`cache._defaultThreshold  after:  ${cache._defaultThreshold}`);

  if (Math.abs(cache._defaultThreshold - NEW_THRESHOLD) < 0.001) {
    log(`✓  Threshold is now ${cache._defaultThreshold} — change is live.`);
  } else {
    log(`✗  Threshold not updated (got: ${cache._defaultThreshold})`);
  }

  // ── 8. Same queries at new threshold ──────────────────────────────────────
  sep(`8 · Same queries at tighter threshold ${NEW_THRESHOLD}`);
  console.log();

  await checkAndLog(cache, 'What is the capital of France?', '  check');

  const after1 = await checkAndLog(cache, "What is France's capital city?", '  check');
  const after2 = await checkAndLog(cache, 'What is the approximate speed of light?', '  check');
  await checkAndLog(cache, 'What is the best pizza topping?', '  check');

  const borderlineHitsAfter = [after1, after2].filter((r) => r.hit).length;
  console.log();
  log(`Borderline queries hitting at ${NEW_THRESHOLD}: ${borderlineHitsAfter}/2`);
  if (borderlineHitsAfter < borderlineHits) {
    log(`✓  ${borderlineHits - borderlineHitsAfter} borderline match(es) eliminated. Those queries`);
    log('   will now reach the LLM for a fresh answer — zero downtime.');
  }

  // ── 9. Per-category override ──────────────────────────────────────────────
  sep('9 · Bonus — per-category override');

  log('Monitor can also propose a per-category threshold so different query');
  log('domains use different precision settings:');
  console.log();
  console.log(`  mcp__betterdb__cache_propose_threshold_adjust({`);
  console.log(`    cache_name:    "${CACHE_NAME}",`);
  console.log(`    new_threshold: 0.22,`);
  console.log(`    category:      "geography",`);
  console.log(`    reasoning:     "Geography queries tolerate slightly looser matching`);
  console.log(`                   because place names have many valid phrasings. Keep`);
  console.log(`                   the global threshold tight at 0.10 but allow 0.22`);
  console.log(`                   for the geography category."`);
  console.log(`  })`);
  console.log();

  // Simulate the per-category dispatcher write:
  await client.hset(configKey, 'threshold:geography', '0.22');
  log(`HSET ${configKey} threshold:geography 0.22  (simulated dispatch)`);

  await countdown(REFRESH_INTERVAL_MS / 1000);
  await sleep(200);

  log(`Global threshold:      ${cache._defaultThreshold}    (unchanged)`);
  log(`Geography threshold:   ${cache._categoryThresholds['geography'] ?? '(not set)'}`);
  console.log();

  // The borderline query now hits again under the looser geography threshold.
  await checkAndLog(cache, "What is France's capital city?", '  check (no category)');
  await checkAndLog(cache, "What is France's capital city?", '  check (geography)', 'geography');

  // ── Cleanup ───────────────────────────────────────────────────────────────
  sep();
  log('Flushing demo cache...');
  await cache.flush();
  log('Done.');
  log('');
  log('In production:');
  log('  • Keep configRefresh.intervalMs at the default 30 000 ms.');
  log('  • Use Monitor\'s MCP tools or web UI to create and approve proposals.');
  log('  • Changes propagate to all running instances within one refresh window.');
  log('  • Per-category overrides let you tune different query domains independently.');

  await client.quit();
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
