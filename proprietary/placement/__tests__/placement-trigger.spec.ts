import { DEFAULT_PLACEMENT_SETTINGS } from '@betterdb/shared';
import type { SustainEntry } from '@app/cluster/sustain-history';
import { PlacementTriggers, readPlacementTrigger } from '../placement-trigger';

const MEDIAN = 100_000;
const MINUTE = 60_000;

function history(
  minutes: number,
  stepSeconds: number,
  at: (minute: number) => { ratio: number; settling?: boolean; share?: number },
): { entries: SustainEntry[]; now: number } {
  const entries: SustainEntry[] = [];
  const end = minutes * MINUTE;
  for (let timestamp = 0; timestamp <= end; timestamp += stepSeconds * 1000) {
    const { ratio, settling = false, share = 0.2 } = at(timestamp / MINUTE);
    entries.push({
      timestamp,
      settling,
      sustainCpuUsecPerSecond: ratio * MEDIAN,
      medianSustainCpuUsecPerSecond: MEDIAN,
      sustainShare: share,
    });
  }
  return { entries, now: end };
}

const settings = DEFAULT_PLACEMENT_SETTINGS;

describe('readPlacementTrigger', () => {
  it.each([5, 15])('reads 30 minutes at 3x the median as over with %i s samples', (step) => {
    const { entries, now } = history(30, step, () => ({ ratio: 3 }));

    expect(readPlacementTrigger(entries, settings, now)).toEqual({
      state: 'over',
      overShare: 1,
      coveredMs: 30 * MINUTE,
      firedAt: null,
      warmUntil: null,
    });
  });

  it.each([5, 15])(
    'reads a 20 minute peak inside 30 minutes as under with %i s samples',
    (step) => {
      const { entries, now } = history(30, step, (minute) => ({
        ratio: minute >= 5 && minute < 25 ? 3 : 1,
      }));

      const read = readPlacementTrigger(entries, settings, now);
      expect(read.state).toBe('under');
      expect(read.overShare).toBeCloseTo(2 / 3, 2);
    },
  );

  it('reads less than 80% of the sustain minutes as too short, and says when it is enough', () => {
    const { entries, now } = history(23, 5, () => ({ ratio: 3 }));

    expect(readPlacementTrigger(entries, settings, now)).toMatchObject({
      state: 'short_history',
      coveredMs: 23 * MINUTE,
      warmUntil: now + MINUTE,
    });
    expect(
      readPlacementTrigger(history(25, 5, () => ({ ratio: 3 })).entries, settings, 25 * MINUTE)
        .state,
    ).toBe('over');
  });

  it('counts settling samples neither way', () => {
    const { entries, now } = history(30, 5, (minute) =>
      minute < 6 ? { ratio: 1, settling: true } : { ratio: 3 },
    );

    expect(readPlacementTrigger(entries, settings, now)).toMatchObject({
      state: 'over',
      overShare: 1,
      coveredMs: 24 * MINUTE,
    });
  });

  it('reads a shard over the CPU share limit as over below the trigger ratio', () => {
    const { entries, now } = history(30, 5, () => ({ ratio: 1.5, share: 0.45 }));

    expect(readPlacementTrigger(entries, settings, now).state).toBe('under');
    expect(readPlacementTrigger(entries, { ...settings, maxCpuShare: 0.4 }, now).state).toBe(
      'over',
    );
  });

  it('drops samples older than the sustain minutes', () => {
    const { entries, now } = history(60, 5, (minute) => ({ ratio: minute < 30 ? 1 : 3 }));

    expect(readPlacementTrigger(entries, settings, now).state).toBe('over');
    expect(readPlacementTrigger(entries, { ...settings, sustainMinutes: 60 }, now).state).toBe(
      'under',
    );
  });
});

describe('PlacementTriggers', () => {
  it('keeps the time the trigger first fired until it turns under', () => {
    const triggers = new PlacementTriggers();
    const over = history(30, 5, () => ({ ratio: 3 }));
    const under = history(30, 5, () => ({ ratio: 1 }));

    const at = over.now;

    expect(triggers.read('seed', 'a', over.entries, settings, at).firedAt).toBe(at);
    expect(triggers.read('seed', 'a', over.entries, settings, at + 1).firedAt).toBe(at);
    expect(triggers.read('seed', 'b', over.entries, settings, at + 1).firedAt).toBe(at + 1);
    expect(triggers.read('seed', 'a', under.entries, settings, at + 2).firedAt).toBeNull();
    expect(triggers.read('seed', 'a', over.entries, settings, at + 3).firedAt).toBe(at + 3);
  });
});
