const BYTE_UNIT = 1024;
const STEP_MULTIPLIERS = [1, 2, 2.5, 5, 10];
const DAY_STEPS = [1, 7, 30, 90, 180, 365];
const TARGET_BYTE_TICKS = 5;
const MAX_DAY_INTERVALS = 6;

export function byteTicks(max: number): number[] {
  if (max <= 0) return [0];
  const unit = BYTE_UNIT ** Math.max(0, Math.floor(Math.log(max) / Math.log(BYTE_UNIT)));
  const raw = max / unit / TARGET_BYTE_TICKS;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const multiplier = STEP_MULTIPLIERS.find((m) => m * magnitude >= raw) ?? 10;
  const step = multiplier * magnitude * unit;
  const count = Math.ceil(max / step);
  return Array.from({ length: count + 1 }, (_, i) => i * step);
}

export function dayTicks(horizonDays: number): number[] {
  const step =
    DAY_STEPS.find((s) => Math.floor(horizonDays / s) <= MAX_DAY_INTERVALS) ?? DAY_STEPS[DAY_STEPS.length - 1];
  return Array.from({ length: Math.floor(horizonDays / step) + 1 }, (_, i) => i * step);
}

export function dayAxis(horizonDays: number): { domain: [number, number]; ticks: number[] } {
  return { domain: [0, horizonDays], ticks: dayTicks(horizonDays) };
}
