/**
 * Pure scoring math for TIGHTEN / LOOSEN proposals. No IO, no DB, no
 * NestJS — pure function so the math is unit-testable in isolation.
 *
 * Geometric mean of three 0–1 components: sample count, signal strength,
 * and sample freshness. One weak component drags the whole score down,
 * which matches the intent — 1000 samples should not rescue a borderline
 * signal.
 */

export const TARGET_SAMPLES = 200;
export const SIGNAL_SAT = 0.8;
export const FRESHNESS_WINDOW_MS = 3_600_000;
export const TIGHTEN_BOUNDARY = 0.2;
export const LOOSEN_BOUNDARY = 0.25;

export interface ConfidenceComponents {
  sample: number;
  signal: number;
  freshness: number;
}

export interface ConfidenceResult {
  score: number;
  breakdown: ConfidenceComponents;
}

export interface ConfidenceInput {
  sampleCount: number;
  /** `uncertainHitRate` for TIGHTEN, `nearMissRate` for LOOSEN. */
  signalRate: number;
  /** Decision boundary the engine used: `TIGHTEN_BOUNDARY` or `LOOSEN_BOUNDARY`. */
  signalBoundary: number;
  /** Epoch ms of the most recent sample in the filtered window. */
  latestRecordedAt: number;
  /** Epoch ms representing "now" (injected for testability). */
  now: number;
}

const clamp01 = (n: number): number => {
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  if (n >= 1) {
    return 1;
  }
  return n;
};

export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  const sample = clamp01(input.sampleCount / TARGET_SAMPLES);
  const signal = clamp01(
    (input.signalRate - input.signalBoundary) / (SIGNAL_SAT - input.signalBoundary),
  );
  const ageMs = input.now - input.latestRecordedAt;
  let freshness: number;
  if (ageMs <= 0) {
    freshness = 1;
  } else {
    freshness = clamp01(1 - ageMs / FRESHNESS_WINDOW_MS);
  }

  const breakdown: ConfidenceComponents = { sample, signal, freshness };

  if (sample === 0 || signal === 0 || freshness === 0) {
    return { score: 0, breakdown };
  }

  const score = Math.cbrt(sample * signal * freshness);
  return { score: clamp01(score), breakdown };
}
