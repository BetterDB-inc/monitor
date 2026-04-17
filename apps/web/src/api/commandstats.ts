import { fetchApi } from './client';

export interface CommandStatsSample {
  id: string;
  connectionId: string;
  command: string;
  callsDelta: number;
  usecDelta: number;
  intervalMs: number;
  capturedAt: number;
}

export interface CommandStatsChartPoint {
  capturedAt: number;
  opsPerSec: number;
  avgLatencyUs: number;
}

export function opsPerSec(sample: CommandStatsSample): number {
  if (sample.intervalMs <= 0) return 0;
  return sample.callsDelta / (sample.intervalMs / 1000);
}

export function avgLatencyUs(sample: CommandStatsSample): number {
  if (sample.callsDelta <= 0) return 0;
  return sample.usecDelta / sample.callsDelta;
}

export function toChartSeries(samples: CommandStatsSample[]): CommandStatsChartPoint[] {
  return [...samples]
    .sort((a, b) => a.capturedAt - b.capturedAt)
    .map((s) => ({
      capturedAt: s.capturedAt,
      opsPerSec: opsPerSec(s),
      avgLatencyUs: avgLatencyUs(s),
    }));
}

export function getCommandStatsHistory(
  command: string,
  options: { from?: number; to?: number; limit?: number } = {},
): Promise<CommandStatsSample[]> {
  const params = new URLSearchParams();
  if (options.from !== undefined) params.set('from', String(options.from));
  if (options.to !== undefined) params.set('to', String(options.to));
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  const qs = params.toString();
  const path = `/metrics/commandstats/${encodeURIComponent(command)}/history${qs ? `?${qs}` : ''}`;
  return fetchApi<CommandStatsSample[]>(path);
}
