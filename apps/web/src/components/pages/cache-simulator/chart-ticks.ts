const BYTE_UNIT = 1024;
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
const STEP_MULTIPLIERS = [1, 2, 2.5, 5, 10];
const DAY_STEPS = [1, 7, 30, 90, 180, 365];
const TARGET_BYTE_TICKS = 5;
const MAX_DAY_INTERVALS = 6;
const STEP_EPSILON = 1e-9;

export interface ByteAxis {
  ticks: number[];
  format: (bytes: number) => string;
}

function unitIndexFor(max: number): number {
  let index = 0;
  while (index < BYTE_UNITS.length - 1 && max >= BYTE_UNIT ** (index + 1)) index++;
  return index;
}

export function byteAxis(dataMax: number, maxmemory: number | null): ByteAxis | null {
  const max = Math.max(dataMax, maxmemory ?? 0);
  if (!Number.isFinite(max) || max <= 0) return null;
  const unitIndex = unitIndexFor(max);
  const unit = BYTE_UNIT ** unitIndex;
  const raw = max / unit / TARGET_BYTE_TICKS;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const stepInUnits = Math.min(...STEP_MULTIPLIERS.filter((m) => m * magnitude >= raw)) * magnitude;
  let count = Math.ceil(max / unit / stepInUnits - STEP_EPSILON);
  if (maxmemory !== null && count * stepInUnits - maxmemory / unit < stepInUnits / 2) count++;
  const decimals = String(stepInUnits).split('.')[1]?.length ?? 0;
  return {
    ticks: Array.from({ length: count + 1 }, (_, i) => i * stepInUnits * unit),
    format: (bytes) => `${bytes === 0 ? '0' : (bytes / unit).toFixed(decimals)} ${BYTE_UNITS[unitIndex]}`,
  };
}

export function dayTicks(horizonDays: number): number[] {
  const step =
    DAY_STEPS.find((s) => Math.floor(horizonDays / s) <= MAX_DAY_INTERVALS) ?? DAY_STEPS[DAY_STEPS.length - 1];
  const ticks = Array.from({ length: Math.floor(horizonDays / step) + 1 }, (_, i) => i * step);
  return ticks[ticks.length - 1] === horizonDays ? ticks : [...ticks, horizonDays];
}
