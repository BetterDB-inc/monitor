import { InfoParser } from '../database/parsers/info.parser';

/**
 * One per-command latency percentile sample from `INFO latencystats`.
 * Values are microseconds, sourced from cumulative t-digests maintained by
 * the server (Valkey/Redis >= 7.0 with `latency-tracking yes`).
 */
export interface LatencyStatsSample {
  command: string;
  p50Us: number;
  p99Us: number;
  p999Us: number;
}

const KEY_PREFIX = 'latency_percentiles_usec_';

function toNumber(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parses the `latencystats` INFO section. Lines look like:
 *   latency_percentiles_usec_get: p50=0.001,p99=1.003,p99.9=4.015
 *
 * The reported percentiles are configurable via
 * `latency-tracking-info-percentiles`, so p50/p99.9 may be missing (default
 * to 0). Commands without a p99 value are skipped entirely — the detection
 * pipeline is p99-based.
 */
export function parseLatencyStatsSection(
  section: Record<string, string> | undefined,
): LatencyStatsSample[] {
  if (!section) {
    return [];
  }

  const samples: LatencyStatsSample[] = [];
  for (const [key, value] of Object.entries(section)) {
    if (!key.startsWith(KEY_PREFIX)) {
      continue;
    }
    const command = key.slice(KEY_PREFIX.length).toLowerCase();
    const fields = InfoParser.parseKvLine(value, ',');

    const p99Us = toNumber(fields.p99);
    if (p99Us === null) {
      continue;
    }

    samples.push({
      command,
      p50Us: toNumber(fields.p50) ?? 0,
      p99Us,
      p999Us: toNumber(fields['p99.9']) ?? 0,
    });
  }

  return samples;
}
