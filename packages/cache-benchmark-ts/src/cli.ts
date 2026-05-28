#!/usr/bin/env node
import { Command } from 'commander';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BetterDBAdapter } from './adapters/betterdb.js';
import { UpstashAdapter } from './adapters/upstash.js';
import type { CacheAdapter } from './adapters/base.js';
import { runReplay } from './harness.js';
import { computeMetrics } from './metrics.js';
import { generateMarkdownReport } from './report.js';
import { toSnakeCase } from './utils.js';
import type { QueryPair, AdapterMode, BenchmarkResult, Metrics } from './types.js';
import { loadStsb } from './datasets/stsb.js';
import { loadSick } from './datasets/sick.js';
import { loadPawsWiki } from './datasets/paws-wiki.js';
import { loadVcacheLmarena } from './datasets/vcache-lmarena.js';

const DEFAULT_THRESHOLDS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45];
const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

const program = new Command()
  .name('cache-bench-ts')
  .description('TypeScript semantic cache benchmark harness')
  .requiredOption('--adapter <name>', 'adapter to benchmark (betterdb, upstash)')
  .requiredOption('--dataset <name>', 'dataset (stsb, sick, paws_wiki, vcache_lmarena)')
  .option('--mode <mode>', 'benchmark mode', 'bare')
  .option('--thresholds <list>', 'comma-separated thresholds', DEFAULT_THRESHOLDS.join(','))
  .option('--limit <n>', 'max pairs per run', '1000')
  .option('--match-threshold <n>', 'STSb/SICK normalized similarity cutoff', '0.6')
  .option('--embedding-model <model>', 'embedding model', DEFAULT_EMBEDDING_MODEL)
  .option('--redis-url <url>', 'Valkey URL', 'redis://localhost:6381')
  .option('--output <dir>', 'output directory', './results')
  .option('--report', 'generate markdown report', false);

program.parse();

const opts = program.opts<{
  adapter: string;
  dataset: string;
  mode: string;
  thresholds: string;
  limit: string;
  matchThreshold: string;
  embeddingModel: string;
  redisUrl: string;
  output: string;
  report: boolean;
}>();

async function main(): Promise<void> {
  const mode = opts.mode as AdapterMode;
  const thresholds = opts.thresholds.split(',').map(Number);
  const limit = parseInt(opts.limit, 10);
  const matchThreshold = parseFloat(opts.matchThreshold);
  const outputDir = opts.output;

  await mkdir(outputDir, { recursive: true });

  // Load dataset
  console.log(`Loading dataset: ${opts.dataset} (limit=${limit})...`);
  const pairs = await loadDataset(opts.dataset, limit, matchThreshold);
  console.log(`Loaded ${pairs.length} pairs`);

  // Run benchmark for each threshold
  const summary: Record<string, Metrics> = {};

  for (const threshold of thresholds) {
    console.log(`\n--- ${opts.adapter} | ${mode} | threshold=${threshold.toFixed(2)} ---`);

    const adapter = buildAdapter(opts.adapter, threshold, opts.embeddingModel, opts.redisUrl, mode);

    try {
      const results = await runReplay(adapter, pairs, (phase, current, total) => {
        if (current % 100 === 0 || current === total) {
          process.stdout.write(`\r  ${phase}: ${current}/${total}`);
        }
      });
      process.stdout.write('\n');

      const metrics = computeMetrics(results);
      const benchResult: BenchmarkResult = {
        adapter: adapter.name,
        mode,
        dataset: opts.dataset,
        initialThreshold: threshold,
        finalThreshold:
          'finalThreshold' in adapter ? (adapter as BetterDBAdapter).finalThreshold : threshold,
        embeddingModel: opts.embeddingModel,
        enabledFeatures: adapter.enabledFeatures(),
        metrics,
        results,
      };

      // Write per-run result
      const filename = `${adapter.name}_${mode}_${opts.dataset}_${threshold.toFixed(2)}.json`;
      await writeFile(
        join(outputDir, filename),
        JSON.stringify(toSnakeCase(benchResult), null, 2),
      );
      console.log(`  Wrote ${filename}`);

      printMetrics(metrics);

      const summaryKey = `${adapter.name}_${threshold.toFixed(2)}`;
      summary[summaryKey] = metrics;
    } finally {
      await adapter.close();
    }
  }

  // Write summary
  const summaryFile = `summary_${mode}_${opts.dataset}.json`;
  await writeFile(
    join(outputDir, summaryFile),
    JSON.stringify(toSnakeCase(summary), null, 2),
  );
  console.log(`\nWrote ${summaryFile}`);

  // Optional markdown report
  if (opts.report) {
    const entries = Object.entries(summary).map(([key, metrics]) => ({ key, metrics }));
    const md = generateMarkdownReport(entries, opts.dataset, mode);
    const reportFile = `report_${mode}_${opts.dataset}.md`;
    await writeFile(join(outputDir, reportFile), md);
    console.log(`Wrote ${reportFile}`);
  }
}

async function loadDataset(
  name: string,
  limit: number,
  matchThreshold: number,
): Promise<QueryPair[]> {
  switch (name) {
    case 'stsb':
      return loadStsb({ limit, matchThreshold });
    case 'sick':
      return loadSick({ limit, matchThreshold });
    case 'paws_wiki':
      return loadPawsWiki({ limit });
    case 'vcache_lmarena':
      return loadVcacheLmarena({ limit });
    default:
      throw new Error(`Unknown dataset: ${name}. Use: stsb, sick, paws_wiki, vcache_lmarena`);
  }
}

function buildAdapter(
  name: string,
  threshold: number,
  embeddingModel: string,
  redisUrl: string,
  mode: AdapterMode,
): CacheAdapter {
  switch (name) {
    case 'betterdb':
      return new BetterDBAdapter(threshold, embeddingModel, redisUrl, mode);
    case 'upstash':
      return new UpstashAdapter(threshold, embeddingModel, redisUrl, mode);
    default:
      throw new Error(`Unknown adapter: ${name}. Use: betterdb, upstash`);
  }
}

function printMetrics(m: Metrics): void {
  console.log(
    `  F1=${(m.f1 * 100).toFixed(1)}%  P=${(m.precision * 100).toFixed(1)}%  ` +
      `R=${(m.recall * 100).toFixed(1)}%  FPR=${(m.falsePositiveRate * 100).toFixed(1)}%  ` +
      `p50=${m.p50LatencyMs.toFixed(1)}ms  p95=${m.p95LatencyMs.toFixed(1)}ms`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
