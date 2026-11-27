import { DEFAULT_PLACEMENT_SETTINGS } from '@betterdb/shared';
import type { ShardLoadSample } from '@app/cluster/shard-load';
import { PlacementTriggers, type TriggerSettings } from '../placement-trigger';

const MEDIAN = 100_000;
const MINUTE = 60_000;
const STALE_MS = 15_000;

interface Moment {
  ratio: number;
  settling?: boolean;
  reset?: boolean;
  shards?: string[];
}

function sampleAt(timestamp: number, moment: Moment): ShardLoadSample {
  const { ratio, settling = false, reset = false, shards = ['a', 'b', 'c'] } = moment;
  return {
    timestamp,
    settling,
    shards: shards.map((nodeId) => ({
      nodeId,
      address: `${nodeId}:7000`,
      slotCount: 100,
      measuredSlots: 100,
      cpuUsecPerSecond: 0,
      sustainCpuUsecPerSecond: nodeId === 'a' ? ratio * MEDIAN : MEDIAN,
      baselineCpuUsecPerSecond: 0,
      sustainReset: reset && nodeId === 'a',
      networkBytesInPerSecond: 0,
      networkBytesOutPerSecond: 0,
      cpuShare: null,
      networkShare: null,
    })),
  };
}

function feed(
  triggers: PlacementTriggers,
  from: number,
  to: number,
  stepSeconds: number,
  at: (minute: number) => Moment | null,
  seedId = 'seed',
): number {
  for (let timestamp = from * MINUTE; timestamp <= to * MINUTE; timestamp += stepSeconds * 1000) {
    const moment = at(timestamp / MINUTE);
    if (moment) triggers.observe(seedId, sampleAt(timestamp, moment), STALE_MS);
  }
  return to * MINUTE;
}

function configured(settings: TriggerSettings = DEFAULT_PLACEMENT_SETTINGS): PlacementTriggers {
  const triggers = new PlacementTriggers();
  triggers.configure('seed', settings);
  return triggers;
}

describe('PlacementTriggers', () => {
  it.each([5, 15])('reads 30 minutes at 3x the median as over with %i s samples', (step) => {
    const triggers = configured();
    const now = feed(triggers, 0, 30, step, () => ({ ratio: 3 }));

    expect(triggers.read('seed', 'a', now, STALE_MS)).toEqual({
      state: 'over',
      overShare: 1,
      coveredMs: 30 * MINUTE,
      firedAt: 24 * MINUTE,
      warmUntil: null,
    });
    expect(triggers.read('seed', 'b', now, STALE_MS)).toMatchObject({
      state: 'under',
      firedAt: null,
    });
  });

  it.each([5, 15])(
    'reads a 20 minute peak inside 30 minutes as under with %i s samples',
    (step) => {
      const triggers = configured();
      const now = feed(triggers, 0, 30, step, (minute) => ({
        ratio: minute >= 5 && minute < 25 ? 3 : 1,
      }));

      const read = triggers.read('seed', 'a', now, STALE_MS);
      expect(read.state).toBe('under');
      expect(read.overShare).toBeCloseTo(2 / 3, 2);
    },
  );

  it('reads less than 80% of the sustain minutes as too short, and says when it is enough', () => {
    const triggers = configured();
    const now = feed(triggers, 0, 23, 5, () => ({ ratio: 3 }));

    expect(triggers.read('seed', 'a', now, STALE_MS)).toMatchObject({
      state: 'short_history',
      coveredMs: 23 * MINUTE,
      warmUntil: now + MINUTE,
    });
    feed(triggers, 23 + 5 / 60, 25, 5, () => ({ ratio: 3 }));
    expect(triggers.read('seed', 'a', 25 * MINUTE, STALE_MS).state).toBe('over');
  });

  it('reads a shard with no samples as short with no end time', () => {
    expect(configured().read('seed', 'a', 0, STALE_MS)).toEqual({
      state: 'short_history',
      overShare: 0,
      coveredMs: 0,
      firedAt: null,
      warmUntil: null,
    });
  });

  it('counts settling samples neither way', () => {
    const triggers = configured();
    const now = feed(triggers, 0, 30, 5, (minute) =>
      minute <= 6 ? { ratio: 1, settling: true } : { ratio: 3 },
    );

    expect(triggers.read('seed', 'a', now, STALE_MS)).toMatchObject({
      state: 'over',
      overShare: 1,
      coveredMs: 24 * MINUTE,
    });
  });

  it('reads a shard over the CPU share limit as over below the trigger ratio', () => {
    const triggers = configured();
    triggers.configure('capped', { ...DEFAULT_PLACEMENT_SETTINGS, maxCpuShare: 0.4 });
    feed(triggers, 0, 30, 5, () => ({ ratio: 1.5 }));
    feed(triggers, 0, 30, 5, () => ({ ratio: 1.5 }), 'capped');

    expect(triggers.read('seed', 'a', 30 * MINUTE, STALE_MS).state).toBe('under');
    expect(triggers.read('capped', 'a', 30 * MINUTE, STALE_MS).state).toBe('over');
  });

  it('drops samples older than the sustain minutes', () => {
    const shortWindow = configured();
    const longWindow = configured({ ...DEFAULT_PLACEMENT_SETTINGS, sustainMinutes: 60 });
    const load = (minute: number) => ({ ratio: minute < 30 ? 1 : 3 });

    expect(shortWindow.read('seed', 'a', feed(shortWindow, 0, 60, 5, load), STALE_MS).state).toBe(
      'over',
    );
    expect(longWindow.read('seed', 'a', feed(longWindow, 0, 60, 5, load), STALE_MS).state).toBe(
      'under',
    );
  });

  it('caps the time one sample covers at the staleness bound', () => {
    const triggers = configured();
    const now = feed(triggers, -30, 35, 5, (minute) => {
      if (minute > 7 && minute < 35) return null;
      return { ratio: minute >= 0 && minute < 20 ? 3 : 1 };
    });

    expect(triggers.read('seed', 'a', now, STALE_MS)).toMatchObject({
      state: 'short_history',
      coveredMs: 2 * MINUTE + STALE_MS,
      firedAt: null,
    });
  });

  it('keeps the time the trigger first fired until it turns under, with no one reading', () => {
    const triggers = configured();
    feed(triggers, 0, 40, 5, () => ({ ratio: 3 }));
    expect(triggers.read('seed', 'a', 40 * MINUTE, STALE_MS).firedAt).toBe(24 * MINUTE);

    feed(triggers, 40 + 5 / 60, 60, 5, () => ({ ratio: 1 }));
    expect(triggers.read('seed', 'a', 60 * MINUTE, STALE_MS)).toMatchObject({
      state: 'under',
      firedAt: null,
    });

    feed(triggers, 60 + 5 / 60, 100, 5, () => ({ ratio: 3 }));
    const refired = triggers.read('seed', 'a', 100 * MINUTE, STALE_MS);
    expect(refired.state).toBe('over');
    expect(refired.firedAt).toBeGreaterThan(60 * MINUTE);
  });

  it('reads a shard whose samples stopped longer ago than the staleness bound as short', () => {
    const triggers = configured();
    const now = feed(triggers, 0, 30, 5, () => ({ ratio: 3 }));

    expect(triggers.read('seed', 'a', now + STALE_MS, STALE_MS).state).toBe('over');
    expect(triggers.read('seed', 'a', now + STALE_MS + 1, STALE_MS)).toMatchObject({
      state: 'short_history',
      firedAt: null,
      warmUntil: null,
    });
  });

  it('starts a shard over when its primary restarted', () => {
    const triggers = configured();
    feed(triggers, 0, 30, 5, () => ({ ratio: 3 }));
    triggers.observe(
      'seed',
      sampleAt(30 * MINUTE + 5_000, { ratio: 3, settling: true, reset: true }),
      STALE_MS,
    );

    expect(triggers.read('seed', 'a', 30 * MINUTE + 5_000, STALE_MS)).toMatchObject({
      state: 'short_history',
      coveredMs: 0,
    });
    expect(triggers.read('seed', 'b', 30 * MINUTE + 5_000, STALE_MS).state).toBe('under');
  });

  it('keeps the history of a shard missing from a poll, and reads it as stale meanwhile', () => {
    const triggers = configured();
    feed(triggers, 0, 30, 5, () => ({ ratio: 3 }));
    const gap = 30 * MINUTE + 5_000;
    triggers.observe('seed', sampleAt(gap, { ratio: 3, shards: ['b', 'c'] }), STALE_MS);

    expect(triggers.read('seed', 'a', gap + STALE_MS + 1, STALE_MS)).toMatchObject({
      state: 'short_history',
      firedAt: null,
    });

    triggers.observe('seed', sampleAt(gap + 5_000, { ratio: 3 }), STALE_MS);
    expect(triggers.read('seed', 'a', gap + 5_000, STALE_MS).state).toBe('over');
  });

  it('forgets a shard once it has been missing for a whole sustain window', () => {
    const triggers = configured();
    feed(triggers, 0, 30, 5, () => ({ ratio: 3 }));
    feed(triggers, 30.5, 61, 30, () => ({ ratio: 3, shards: ['b', 'c', 'd'] }));
    triggers.observe('seed', sampleAt(61 * MINUTE + 5_000, { ratio: 3 }), STALE_MS);

    expect(triggers.read('seed', 'a', 61 * MINUTE + 5_000, STALE_MS)).toMatchObject({
      state: 'short_history',
      coveredMs: 0,
      firedAt: null,
    });
  });

  describe('with too few shards or too little load to judge', () => {
    const sharesOf = (loads: number[]) => (timestamp: number) => ({
      timestamp,
      settling: false,
      shards: loads.map((load, index) => ({
        ...sampleAt(timestamp, { ratio: 1 }).shards[0],
        nodeId: 'abcd'[index],
        sustainCpuUsecPerSecond: load,
      })),
    });
    const run = (loads: number[], maxCpuShare: number) => {
      const triggers = configured({ ...DEFAULT_PLACEMENT_SETTINGS, maxCpuShare });
      const at = sharesOf(loads);
      for (let timestamp = 0; timestamp <= 30 * MINUTE; timestamp += 5_000) {
        triggers.observe('seed', at(timestamp), STALE_MS);
      }
      return triggers.read('seed', 'a', 30 * MINUTE, STALE_MS).state;
    };

    it('reads the busier of two primaries as under for any CPU share limit', () => {
      expect(run([120_000, 100_000], 0.5)).toBe('under');
    });

    it('reads a single primary as under although its share is 1', () => {
      expect(run([100_000], 0.9)).toBe('under');
    });

    it('reads a near-idle shard as under over the CPU share limit', () => {
      expect(run([30, 10, 10], 0.4)).toBe('under');
    });

    it('still reads a busy shard over the CPU share limit as over', () => {
      expect(run([150_000, 100_000, 50_000], 0.4)).toBe('over');
    });
  });

  it('starts over when the trigger settings change, and keeps the history when they do not', () => {
    const triggers = configured();
    const now = feed(triggers, 0, 30, 5, () => ({ ratio: 3 }));

    triggers.configure('seed', { ...DEFAULT_PLACEMENT_SETTINGS });
    expect(triggers.read('seed', 'a', now, STALE_MS).state).toBe('over');

    triggers.configure('seed', { ...DEFAULT_PLACEMENT_SETTINGS, sustainMinutes: 45 });
    expect(triggers.read('seed', 'a', now, STALE_MS).coveredMs).toBe(0);
  });

  it('ignores samples of a cluster whose settings it has not been given', () => {
    const triggers = new PlacementTriggers();
    const now = feed(triggers, 0, 30, 5, () => ({ ratio: 3 }));

    expect(triggers.read('seed', 'a', now, STALE_MS).coveredMs).toBe(0);
  });

  it('keeps one bucket a minute at most for a day of samples', () => {
    const triggers = configured({ ...DEFAULT_PLACEMENT_SETTINGS, sustainMinutes: 1440 });
    const now = feed(triggers, 0, 2 * 1440, 5, () => ({ ratio: 3 }));

    const read = triggers.read('seed', 'a', now, STALE_MS);
    expect(read.coveredMs).toBe(1440 * MINUTE);
    const buckets = (
      triggers as unknown as {
        tracks: Map<string, { shards: Map<string, { buckets: unknown[] }> }>;
      }
    ).tracks
      .get('seed')
      ?.shards.get('a')?.buckets;
    expect(buckets?.length).toBeLessThanOrEqual(1441);
  });
});
