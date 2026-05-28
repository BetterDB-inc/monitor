import type { Metrics } from './types.js';

interface SummaryEntry {
  key: string;
  metrics: Metrics;
}

export function generateMarkdownReport(
  entries: SummaryEntry[],
  dataset: string,
  mode: string,
): string {
  const lines: string[] = [];
  lines.push(`# Benchmark Report: ${dataset} (${mode})`);
  lines.push('');
  lines.push(
    '| Adapter / Threshold | F1 | Precision | Recall | FPR | Hit Rate | p50 (ms) | p95 (ms) |',
  );
  lines.push(
    '|---------------------|----|-----------|--------|-----|----------|----------|----------|',
  );

  for (const entry of entries) {
    const m = entry.metrics;
    lines.push(
      `| ${entry.key} ` +
        `| ${pct(m.f1)} ` +
        `| ${pct(m.precision)} ` +
        `| ${pct(m.recall)} ` +
        `| ${pct(m.falsePositiveRate)} ` +
        `| ${pct(m.hitRate)} ` +
        `| ${m.p50LatencyMs.toFixed(1)} ` +
        `| ${m.p95LatencyMs.toFixed(1)} |`,
    );
  }

  // F1 sparklines per adapter
  const adapters = new Map<string, number[]>();
  for (const entry of entries) {
    const [adapter] = entry.key.split('_');
    let f1s = adapters.get(adapter);
    if (!f1s) {
      f1s = [];
      adapters.set(adapter, f1s);
    }
    f1s.push(entry.metrics.f1);
  }

  lines.push('');
  lines.push('## F1 Trend');
  lines.push('');
  for (const [adapter, f1s] of adapters) {
    lines.push(`**${adapter}**: ${sparkline(f1s)}`);
  }

  // Best F1 per adapter
  lines.push('');
  lines.push('## Best F1');
  lines.push('');
  for (const [adapter, f1s] of adapters) {
    const best = Math.max(...f1s);
    const idx = f1s.indexOf(best);
    const matchingEntry = entries.filter((e) => e.key.startsWith(adapter + '_'))[idx];
    lines.push(`- **${adapter}**: ${pct(best)} (${matchingEntry?.key ?? 'N/A'})`);
  }

  return lines.join('\n');
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

const SPARK_CHARS = ' _\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588';

function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values.map((v) => {
    const idx = Math.round(((v - min) / range) * (SPARK_CHARS.length - 1));
    return SPARK_CHARS[idx];
  }).join('');
}
