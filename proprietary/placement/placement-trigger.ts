import type { PlacementSettings, PlacementTriggerRead } from '@betterdb/shared';
import type { SustainEntry } from '@app/cluster/sustain-history';
import { hotShardRatio } from '../anomaly-detection/hot-shard-detector';

export const TRIGGER_MIN_HISTORY_SHARE = 0.8;
export const TRIGGER_OVER_SHARE = 0.9;

type TriggerSettings = Pick<PlacementSettings, 'sustainMinutes' | 'triggerRatio' | 'maxCpuShare'>;

function isOver(entry: SustainEntry, settings: TriggerSettings): boolean {
  const ratio = hotShardRatio(entry.sustainCpuUsecPerSecond, entry.medianSustainCpuUsecPerSecond);
  if (ratio >= settings.triggerRatio) return true;
  return settings.maxCpuShare !== null && entry.sustainShare >= settings.maxCpuShare;
}

export function readPlacementTrigger(
  entries: readonly SustainEntry[],
  settings: TriggerSettings,
  now: number,
): PlacementTriggerRead {
  const sustainMs = settings.sustainMinutes * 60_000;
  const window = entries.filter(
    (entry) => entry.timestamp >= now - sustainMs && entry.timestamp <= now,
  );
  let coveredMs = 0;
  let overMs = 0;
  for (let index = 0; index + 1 < window.length; index++) {
    const entry = window[index];
    if (entry.settling) continue;
    const weight = window[index + 1].timestamp - entry.timestamp;
    coveredMs += weight;
    if (isOver(entry, settings)) overMs += weight;
  }
  const overShare = coveredMs > 0 ? overMs / coveredMs : 0;
  const neededMs = TRIGGER_MIN_HISTORY_SHARE * sustainMs;
  if (coveredMs < neededMs) {
    return {
      state: 'short_history',
      overShare,
      coveredMs,
      firedAt: null,
      warmUntil: now + (neededMs - coveredMs),
    };
  }
  return {
    state: overShare >= TRIGGER_OVER_SHARE ? 'over' : 'under',
    overShare,
    coveredMs,
    firedAt: null,
    warmUntil: null,
  };
}

export class PlacementTriggers {
  private readonly fired = new Map<string, Map<string, number>>();

  read(
    seedId: string,
    shardId: string,
    entries: readonly SustainEntry[],
    settings: TriggerSettings,
    now: number,
  ): PlacementTriggerRead {
    const read = readPlacementTrigger(entries, settings, now);
    const fired = this.fired.get(seedId) ?? new Map<string, number>();
    if (read.state !== 'over') {
      fired.delete(shardId);
      return read;
    }
    const firedAt = fired.get(shardId) ?? now;
    fired.set(shardId, firedAt);
    this.fired.set(seedId, fired);
    return { ...read, firedAt };
  }

  seeds(): string[] {
    return [...this.fired.keys()];
  }

  forget(seedId: string): void {
    this.fired.delete(seedId);
  }
}
