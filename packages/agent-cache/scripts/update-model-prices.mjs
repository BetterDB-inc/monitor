#!/usr/bin/env node
/**
 * Fetches model pricing from LiteLLM's model_prices_and_context_window.json
 * and writes packages/agent-cache/src/defaultCostTable.ts.
 *
 * Run via: pnpm --filter @betterdb/agent-cache update:pricing
 */

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, '..', 'src', 'defaultCostTable.ts');

const PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const COMMITS_URL =
  'https://api.github.com/repos/BerriAI/litellm/commits/main';

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'betterdb-agent-cache-pricing-updater', ...opts.headers },
    ...opts,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.json();
}

async function main() {
  // Fetch both in parallel
  let prices, commits;
  try {
    [prices, commits] = await Promise.all([
      fetchJson(PRICES_URL),
      fetchJson(COMMITS_URL),
    ]);
  } catch (err) {
    console.error(`Error fetching data: ${err.message}`);
    process.exit(1);
  }

  // Extract short SHA
  let shortSha;
  try {
    const sha = commits[0]?.sha ?? commits?.sha;
    if (!sha) throw new Error('Could not find sha in commits response');
    shortSha = sha.slice(0, 7);
  } catch (err) {
    console.error(`Error extracting commit SHA: ${err.message}`);
    process.exit(1);
  }

  // Filter and transform entries
  let entries;
  try {
    entries = Object.entries(prices)
      .filter(([key, val]) => {
        if (key === 'sample_spec') return false;
        if (key.startsWith('_')) return false;
        if (typeof val !== 'object' || val === null) return false;
        const input = val.input_cost_per_token;
        const output = val.output_cost_per_token;
        return typeof input === 'number' && typeof output === 'number' && input > 0 && output > 0;
      })
      .map(([key, val]) => [
        key,
        {
          inputPer1k: val.input_cost_per_token * 1000,
          outputPer1k: val.output_cost_per_token * 1000,
        },
      ]);
  } catch (err) {
    console.error(`Error processing price data: ${err.message}`);
    process.exit(1);
  }

  // Sort keys alphabetically for stable diffs
  entries.sort((a, b) => a[0].localeCompare(b[0]));

  const count = entries.length;
  const fetchedAt = new Date().toISOString();

  // Build the TypeScript source
  const lines = [
    '/**',
    ' * AUTO-GENERATED. Do not edit by hand.',
    ' * Source: https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json',
    ` * Commit: ${shortSha}`,
    ` * Fetched: ${fetchedAt}`,
    ` * Entries: ${count}`,
    ' *',
    ' * Regenerate: pnpm --filter @betterdb/agent-cache update:pricing',
    ' */',
    "import type { ModelCost } from './types';",
    '',
    "export const DEFAULT_COST_TABLE: Record<string, ModelCost> = {",
  ];

  for (const [key, val] of entries) {
    const escapedKey = key.replace(/'/g, "\\'");
    lines.push(
      `  '${escapedKey}': { inputPer1k: ${val.inputPer1k}, outputPer1k: ${val.outputPer1k} },`,
    );
  }

  lines.push('};', '');

  try {
    writeFileSync(OUT_FILE, lines.join('\n'), 'utf8');
  } catch (err) {
    console.error(`Error writing ${OUT_FILE}: ${err.message}`);
    process.exit(1);
  }

  console.log(`Wrote ${count} entries to src/defaultCostTable.ts (commit ${shortSha})`);
}

main();
