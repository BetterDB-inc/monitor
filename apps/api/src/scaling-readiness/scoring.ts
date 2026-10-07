import {
  READINESS_DIMENSION_LABELS,
  type ReadinessBand,
  type ReadinessDimension,
  type ReadinessDimensionKey,
  type ScalingReadiness,
} from '@betterdb/shared';

export type DimensionInput = { score: number; detail: string } | { excludedReason: string };
export type DimensionInputs = Record<ReadinessDimensionKey, DimensionInput>;

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

export const DIMENSION_ORDER: ReadinessDimensionKey[] = [
  'memory',
  'connections',
  'cpu',
  'opsTrend',
  'keyspaceGrowth',
];

export const DIMENSION_WEIGHTS: Record<ReadinessDimensionKey, number> = {
  memory: 30,
  connections: 20,
  cpu: 20,
  opsTrend: 15,
  keyspaceGrowth: 15,
};

const SENTENCE_LABELS: Record<ReadinessDimensionKey, string> = {
  memory: 'memory',
  connections: 'connections',
  cpu: 'CPU',
  opsTrend: 'throughput trend',
  keyspaceGrowth: 'keyspace growth',
};

const WORST_CAP_MARGIN = 15;

export function linearHeadroom(value: number, full: number, zero: number): number {
  const progress = (value - full) / (zero - full);
  if (!(progress > 0)) return 100;
  if (progress >= 1) return 0;
  return (1 - progress) * 100;
}

export function utilizationHeadroom(ratio: number, saturation: number): number {
  return linearHeadroom(ratio, 0.5, saturation);
}

export function growthHeadroom(weeklyGrowthPercent: number): number {
  return linearHeadroom(weeklyGrowthPercent, 0, 50);
}

export function timeToLimitHeadroom(ms: number): number {
  return linearHeadroom(ms, 30 * DAY_MS, DAY_MS);
}

export function bandFor(score: number): ReadinessBand {
  if (score >= 70) return 'green';
  if (score >= 40) return 'yellow';
  return 'red';
}

function isAvailable(input: DimensionInput): input is { score: number; detail: string } {
  return 'score' in input;
}

function excludedDimension(key: ReadinessDimensionKey, reason: string): ReadinessDimension {
  return {
    key,
    score: null,
    weight: DIMENSION_WEIGHTS[key],
    contribution: null,
    detail: null,
    excludedReason: reason,
  };
}

export function notApplicable(
  connectionId: string,
  computedAt: number,
  summary: string,
): ScalingReadiness {
  return {
    connectionId,
    computedAt,
    score: null,
    band: null,
    bindingDimension: null,
    summary,
    cappedBy: null,
    dimensions: DIMENSION_ORDER.map((key) => excludedDimension(key, summary)),
  };
}

export function scoreReadiness(
  connectionId: string,
  computedAt: number,
  inputs: DimensionInputs,
): ScalingReadiness {
  const headroom = new Map<ReadinessDimensionKey, number>();
  for (const key of DIMENSION_ORDER) {
    const input = inputs[key];
    if (isAvailable(input)) headroom.set(key, Math.round(Math.min(100, Math.max(0, input.score))));
  }

  if (headroom.size === 0) {
    return {
      ...notApplicable(connectionId, computedAt, 'Not enough data yet'),
      dimensions: DIMENSION_ORDER.map((key) =>
        excludedDimension(key, (inputs[key] as { excludedReason: string }).excludedReason),
      ),
    };
  }

  const available = DIMENSION_ORDER.filter((key) => headroom.has(key));
  const totalWeight = available.reduce((sum, key) => sum + DIMENSION_WEIGHTS[key], 0);
  const contributions = new Map(
    available.map((key) => [key, (DIMENSION_WEIGHTS[key] / totalWeight) * headroom.get(key)!]),
  );
  const weighted = [...contributions.values()].reduce((sum, value) => sum + value, 0);

  const binding = [...available].sort(
    (a, b) =>
      headroom.get(a)! - headroom.get(b)! ||
      DIMENSION_WEIGHTS[b] - DIMENSION_WEIGHTS[a] ||
      DIMENSION_ORDER.indexOf(a) - DIMENSION_ORDER.indexOf(b),
  )[0];
  const cap = headroom.get(binding)! + WORST_CAP_MARGIN;
  const score = Math.round(Math.min(weighted, cap));
  const band = bandFor(score);
  const bindingInput = inputs[binding] as { score: number; detail: string };

  return {
    connectionId,
    computedAt,
    score,
    band,
    bindingDimension: binding,
    summary:
      band === 'green'
        ? `Plenty of headroom; ${SENTENCE_LABELS[binding]} is closest to its limit.`
        : `${READINESS_DIMENSION_LABELS[binding]} is your binding constraint (${bindingInput.detail}).`,
    cappedBy: cap < weighted ? binding : null,
    dimensions: DIMENSION_ORDER.map((key) => {
      const input = inputs[key];
      if (!isAvailable(input)) return excludedDimension(key, input.excludedReason);
      return {
        key,
        score: headroom.get(key)!,
        weight: DIMENSION_WEIGHTS[key],
        contribution: Math.round(contributions.get(key)! * 10) / 10,
        detail: input.detail,
        excludedReason: null,
      };
    }),
  };
}
