import { percentile } from '../../src/monitor/cross-reference.engine';

export interface PollerResult {
  intervalMs: number;
  ticks: number;
  expectedTicks: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  commandsPerTick: number;
  commandsPerSecond: number;
}

export const round = (value: number, digits = 1): number => Number(value.toFixed(digits));

export function pollerResult(
  durations: number[],
  intervalMs: number,
  commands: number,
  windowSeconds: number,
): PollerResult {
  return {
    intervalMs,
    ticks: durations.length,
    expectedTicks: intervalMs > 0 ? Math.floor((windowSeconds * 1000) / intervalMs) : 0,
    p50Ms: round(percentile(durations, 0.5)),
    p95Ms: round(percentile(durations, 0.95)),
    maxMs: round(durations.length ? Math.max(...durations) : 0),
    commandsPerTick: durations.length ? round(commands / durations.length) : 0,
    commandsPerSecond: round(commands / windowSeconds),
  };
}
