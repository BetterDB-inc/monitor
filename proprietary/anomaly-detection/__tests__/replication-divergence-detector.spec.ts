import {
  DIVERGENCE_RECOVERED_WINDOWS,
  ClosedDivergenceWindow,
  DIVERGENCE_MIN_WINDOW_MS,
  DIVERGENCE_PERSIST_BACKLOG,
  DivergenceConnectionState,
  DivergenceFinding,
  DivergenceOutcome,
  acknowledgeDivergence,
  acknowledgeRecovery,
  createDivergenceState,
  describeDivergence,
  divergenceWindowMs,
  drainClosedWindows,
  observeDivergence,
  staleAckWindow,
  divergenceWindowsHeld,
  replicaObservedLevel,
  requeueClosedWindows,
  assessOrphanedReplica,
  DIVERGENCE_DISAGREE_WINDOWS,
  ReplicaViewReading,
  ViewDisagreement,
  acknowledgeViewAgreement,
  acknowledgeViewDisagreement,
  applyReplicaViews,
  describeViewDisagreement,
  replicaEventIds,
  replicasToSample,
} from '../replication-divergence-detector';
import { ReplicaOffset, ReplicationStreamSample, ReplicationStreamTracker } from '../replication-stream';

const MiB = 1024 * 1024;
const WINDOW_MS = 30_000;
const POLL_MS = 10_000;
const ADDR = '10.0.0.2:6379';

interface WindowSpec {
  gap: number;
  rate: number | null;
  state?: string;
  lagSec?: number | null;
  present?: boolean;
  offset?: number;
}

class Harness {
  readonly state: DivergenceConnectionState = createDivergenceState();
  t = 1_700_000_000_000;

  sample(spec: WindowSpec): ReplicationStreamSample {
    const replicas: ReplicaOffset[] =
      spec.present === false
        ? []
        : [
            {
              key: 'slave0',
              addr: ADDR,
              state: spec.state ?? 'online',
              offset: spec.offset ?? 1,
              lagSec: spec.lagSec === undefined ? 0 : spec.lagSec,
              gapBytes: spec.gap,
            },
          ];
    return {
      timestamp: this.t,
      role: 'primary',
      replid: 'a'.repeat(40),
      masterReplOffset: 0,
      bytesPerSec: spec.rate,
      bytesPerSecEwma: spec.rate,
      replBacklogSize: null,
      replicas,
    };
  }

  window(spec: WindowSpec, ack: boolean): DivergenceOutcome[] {
    const outcomes: DivergenceOutcome[] = [];
    for (let i = 0; i < WINDOW_MS / POLL_MS; i++) {
      const emitted = observeDivergence(this.state, this.sample(spec), WINDOW_MS);
      if (ack) {
        for (const o of emitted) {
          if (o.kind === 'divergence') acknowledgeDivergence(this.state, o, `evt-${o.level}`);
          else acknowledgeRecovery(this.state, o.addr);
        }
      }
      outcomes.push(...emitted);
      this.t += POLL_MS;
    }
    return outcomes;
  }

  skip(ms: number): void {
    this.t += ms;
  }

  poll(spec: WindowSpec, stepMs: number): DivergenceOutcome[] {
    const emitted = observeDivergence(this.state, this.sample(spec), WINDOW_MS);
    this.t += stepMs;
    return emitted;
  }

  windows(specs: WindowSpec[], ack = true): DivergenceOutcome[][] {
    return specs.map((spec) => this.window(spec, ack));
  }
}

const climbingLag = (window: number): number => 20 + window * (WINDOW_MS / 1000);

function divergences(outcomes: DivergenceOutcome[][]): DivergenceFinding[] {
  return outcomes.flat().filter((o): o is DivergenceFinding => o.kind === 'divergence');
}

describe('divergenceWindowsHeld', () => {
  it('sends a start on the eviction boundary to storage', () => {
    const h = new Harness();
    h.state.windowsHeldSince = h.t;

    expect(divergenceWindowsHeld(h.state, h.t)).toBe(false);
    expect(divergenceWindowsHeld(h.state, h.t + 1)).toBe(true);
  });
});

describe('baseline and outage handling', () => {
  it('keeps a ceiling alert below critical while the burst behind it continues', () => {
    const h = new Harness();
    h.windows(Array.from({ length: 6 }, () => ({ gap: 0, rate: MiB })));
    h.windows(Array.from({ length: 8 }, () => ({ gap: 100 * MiB, rate: 10 * MiB })));
    const burst = divergences(h.windows(Array.from({ length: 10 }, () => ({ gap: 400 * MiB, rate: 10 * MiB }))));

    expect(burst.map((f) => f.reason)).toEqual(['ceiling']);
    expect(burst[0].level).toBe('warning');
  });

  it('holds no baseline when monitoring starts inside a burst', () => {
    const h = new Harness();
    const burst = divergences(h.windows(Array.from({ length: 10 }, () => ({ gap: 400 * MiB, rate: 10 * MiB }))));

    expect(burst.map((f) => f.reason)).toEqual(['ceiling']);
    expect(h.state.replicas.get(ADDR)?.baselineRate).toBeNull();
  });

  it('escalates a replica first flagged by stale acks once writes return to baseline', () => {
    const h = new Harness();
    h.windows(Array.from({ length: 6 }, () => ({ gap: 0, rate: MiB })));
    h.windows([
      { gap: 100 * MiB, rate: MiB, lagSec: climbingLag(0) },
      { gap: 100 * MiB, rate: MiB, lagSec: climbingLag(1) },
    ]);
    const resumed = divergences(h.windows(Array.from({ length: 7 }, () => ({ gap: 100 * MiB, rate: MiB }))));
    expect(resumed.at(-1)).toMatchObject({ level: 'critical', reason: 'not_catching_up' });
  });

  it('takes the idle check of a window sealed by an outage from before the outage', () => {
    const h = new Harness();
    for (let i = 0; i < 3; i++) h.poll({ gap: 8 * MiB, rate: 1000 }, 15_000);
    h.skip(300_000);
    h.poll({ gap: 8 * MiB, rate: 50 * MiB }, POLL_MS);
    expect(h.state.rateHistory).toEqual([0]);
    expect(h.state.replicas.get(ADDR)?.windows[0].bytesPerSec).toBe(0);
  });

  it('seals a window of writes at its own rate when an outage ends it', () => {
    const h = new Harness();
    for (let i = 0; i < 3; i++) h.poll({ gap: 8 * MiB, rate: 2 * MiB }, 15_000);
    h.skip(300_000);
    h.poll({ gap: 8 * MiB, rate: 50 * MiB }, POLL_MS);
    expect(h.state.rateHistory).toEqual([2 * MiB]);
  });
});

describe('divergenceWindowMs', () => {
  it('uses 30s or three poll intervals, whichever is longer', () => {
    expect(divergenceWindowMs(1000)).toBe(DIVERGENCE_MIN_WINDOW_MS);
    expect(divergenceWindowMs(15_000)).toBe(45_000);
  });
});

interface TimingStep {
  after: number;
  gap: number;
  lagSec?: number;
  role?: 'replica';
  restart?: boolean;
}

interface TimingRow {
  name: string;
  steps: TimingStep[];
  windows: [number, number][];
  chain: number;
  openedAt: number | null;
  alerts: string[];
}

const polls = (
  count: number,
  after: number,
  gap: (i: number) => number,
  lagSec?: (i: number) => number,
): TimingStep[] => Array.from({ length: count }, (_, i) => ({ after, gap: gap(i), lagSec: lagSec?.(i) }));

const lagFrom = (startSec: number) => (i: number) => startSec + i * 10;

const flat = () => 8;

const TIMING_ROWS: TimingRow[] = [
  {
    name: 'regular polling closes contiguous windows',
    steps: polls(7, 10_000, flat),
    windows: [
      [10_000, 40_000],
      [40_000, 70_000],
    ],
    chain: 2,
    openedAt: 70_000,
    alerts: [],
  },
  {
    name: '4426209170: polls under a window apart keep it open until it has 3 samples',
    steps: polls(7, 20_000, flat),
    windows: [
      [20_000, 80_000],
      [80_000, 140_000],
    ],
    chain: 2,
    openedAt: 140_000,
    alerts: [],
  },
  {
    name: 'a gap of exactly one window is still polling',
    steps: [...polls(4, 10_000, flat), ...polls(3, 30_000, flat)],
    windows: [
      [10_000, 40_000],
      [40_000, 130_000],
    ],
    chain: 2,
    openedAt: 130_000,
    alerts: [],
  },
  {
    name: '4426209182: growth does not carry across an outage',
    steps: [
      ...polls(3, 10_000, () => 8),
      ...polls(3, 10_000, () => 10),
      ...polls(3, 10_000, () => 12),
      { after: 300_000, gap: 14 },
      ...polls(2, 10_000, () => 14),
      ...polls(3, 10_000, () => 16),
      ...polls(3, 10_000, () => 18),
      { after: 10_000, gap: 20 },
    ],
    windows: [
      [10_000, 40_000],
      [40_000, 70_000],
      [390_000, 420_000],
      [420_000, 450_000],
      [450_000, 480_000],
    ],
    chain: 3,
    openedAt: 480_000,
    alerts: [],
  },
  {
    name: '4426393171: an outage seals a full window with 3 samples at its last sample',
    steps: [...polls(3, 20_000, flat), { after: 300_000, gap: 8 }],
    windows: [[20_000, 60_000]],
    chain: 1,
    openedAt: 360_000,
    alerts: [],
  },
  {
    name: '4426393171: polls just over a window apart still close windows and alert',
    steps: polls(14, 31_000, (i) => 8 + 2 * i),
    windows: [
      [62_000, 155_000],
      [155_000, 248_000],
      [248_000, 341_000],
      [341_000, 434_000],
    ],
    chain: 4,
    openedAt: 434_000,
    alerts: ['growth'],
  },
  {
    name: '4426472012: an outage discards a window it cut short',
    steps: [...polls(3, 1_000, flat), { after: 300_000, gap: 8 }],
    windows: [],
    chain: 0,
    openedAt: 303_000,
    alerts: [],
  },
  {
    name: '4426472029: a blackout during slow polling restarts the chain',
    steps: [...polls(9, 40_000, flat), { after: 600_000, gap: 8 }, ...polls(3, 40_000, flat)],
    windows: [
      [80_000, 200_000],
      [200_000, 320_000],
      [960_000, 1_080_000],
    ],
    chain: 1,
    openedAt: 1_080_000,
    alerts: [],
  },
  {
    name: 'a gap of at most twice the last one stays polling',
    steps: [...polls(2, 40_000, flat), { after: 80_000, gap: 8 }, ...polls(2, 40_000, flat)],
    windows: [[80_000, 240_000]],
    chain: 1,
    openedAt: 240_000,
    alerts: [],
  },
  {
    name: 'two equal blackouts in a row read as slow polling',
    steps: [...polls(2, 10_000, flat), ...polls(4, 300_000, flat)],
    windows: [[320_000, 1_220_000]],
    chain: 1,
    openedAt: 1_220_000,
    alerts: [],
  },
  {
    name: 'an unacked replica warns over contiguous windows under a raised repl-timeout',
    steps: polls(7, 10_000, () => 20, lagFrom(11)),
    windows: [],
    chain: 0,
    openedAt: 70_000,
    alerts: ['not_acking'],
  },
  {
    name: 'an outage restarts the unacked streak',
    steps: [
      ...polls(4, 10_000, () => 20, lagFrom(11)),
      { after: 300_000, gap: 20, lagSec: 11 },
      ...polls(3, 10_000, () => 20, lagFrom(21)),
    ],
    windows: [],
    chain: 0,
    openedAt: 370_000,
    alerts: [],
  },
  {
    name: 'a detector restart drops the open window and the chain',
    steps: [
      ...polls(3, 10_000, () => 2),
      ...polls(3, 10_000, () => 8),
      ...polls(3, 10_000, () => 16),
      { after: 10_000, gap: 24, restart: true },
      ...polls(2, 10_000, () => 24),
      ...polls(3, 10_000, () => 32),
      ...polls(1, 10_000, () => 40),
    ],
    windows: [
      [100_000, 130_000],
      [130_000, 160_000],
    ],
    chain: 2,
    openedAt: 160_000,
    alerts: [],
  },
  {
    name: 'losing the primary role drops the open window and the chain',
    steps: [
      ...polls(4, 10_000, flat),
      { after: 10_000, gap: 8, role: 'replica' },
      ...polls(4, 10_000, flat),
    ],
    windows: [[60_000, 90_000]],
    chain: 1,
    openedAt: 90_000,
    alerts: [],
  },
];

describe('observeDivergence window timing', () => {
  it.each(TIMING_ROWS)('$name', ({ steps, windows, chain, openedAt, alerts }) => {
    const start = 1_700_000_000_000;
    let harness = new Harness();
    let t = start;
    const outcomes: DivergenceOutcome[] = [];

    for (const step of steps) {
      t += step.after;
      if (step.restart) harness = new Harness();
      harness.t = t;
      const spec = { gap: step.gap * MiB, rate: MiB, lagSec: step.lagSec };
      const sample = { ...harness.sample(spec), role: step.role ?? ('primary' as const) };
      const emitted = observeDivergence(harness.state, sample, WINDOW_MS);
      for (const o of emitted) {
        if (o.kind === 'divergence') acknowledgeDivergence(harness.state, o, `evt-${o.level}`);
        else acknowledgeRecovery(harness.state, o.addr);
      }
      outcomes.push(...emitted);
    }

    const closed = harness.state.replicas.get(ADDR)?.windows ?? [];
    let trailing = closed.length > 0 ? 1 : 0;
    while (trailing > 0 && trailing < closed.length) {
      const at = closed.length - trailing;
      if (closed[at - 1].end !== closed[at].start) break;
      trailing++;
    }
    expect(closed.map((w) => [w.start - start, w.end - start])).toEqual(windows);
    expect(trailing).toBe(chain);
    expect(harness.state.windowStart === null ? null : harness.state.windowStart - start).toBe(openedAt);
    expect(divergences([outcomes]).map((f) => f.reason)).toEqual(alerts);
  });
});

describe('observeDivergence', () => {
  it('ignores a replica in initial sync that has not acked an offset', () => {
    const harness = new Harness();

    const out = harness.windows(
      Array.from({ length: 2 }, (_, i) => ({ gap: 500 * MiB, rate: MiB, lagSec: climbingLag(i), offset: 0 })),
    );

    expect(divergences(out)).toEqual([]);
    expect(harness.state.replicas.has(ADDR)).toBe(false);
  });

  it('ignores an unacked replica before its lag goes stale', () => {
    const harness = new Harness();

    harness.windows(Array.from({ length: 3 }, () => ({ gap: 500 * MiB, rate: MiB, lagSec: 2, offset: 0 })));

    expect(harness.state.replicas.has(ADDR)).toBe(false);
  });

  it('ignores samples from replicas', () => {
    const state = createDivergenceState();
    const sample: ReplicationStreamSample = {
      timestamp: 0,
      role: 'replica',
      replid: null,
      masterReplOffset: 0,
      bytesPerSec: 1,
      bytesPerSecEwma: 1,
      replBacklogSize: null,
      replicas: [],
    };
    expect(observeDivergence(state, sample, WINDOW_MS)).toEqual([]);
  });

  it('stays quiet through a write burst that recovers', () => {
    const h = new Harness();
    const rate = 0.5 * MiB;
    const climb = h.windows([4, 6, 8].map((m) => ({ gap: m * MiB, rate })));
    expect(replicaObservedLevel(h.state, ADDR, h.t, WINDOW_MS)).toBe('behind');

    const drain = h.windows([4, 2, 0, 0].map((m) => ({ gap: m * MiB, rate })));
    expect([...climb, ...drain].flat()).toEqual([]);
    expect(replicaObservedLevel(h.state, ADDR, h.t, WINDOW_MS)).toBe('none');
  });

  it('warns on a gap that grows across four windows', () => {
    const h = new Harness();
    const [finding] = divergences(h.windows([2, 4, 6, 8, 8].map((m) => ({ gap: m * MiB, rate: MiB }))));
    expect(finding).toMatchObject({
      kind: 'divergence',
      addr: ADDR,
      level: 'warning',
      reason: 'growth',
      gapBytes: 8 * MiB,
      secondsBehind: 8,
      windowCount: 4,
      slopeBytesPerWindow: 2 * MiB,
    });
  });

  it('keeps re-emitting until the finding is acknowledged, then only escalates', () => {
    const h = new Harness();
    const out = h.windows(
      [2, 4, 6, 8, 10, 12].map((m) => ({ gap: m * MiB, rate: MiB })),
      false,
    );
    expect(divergences(out).map((f) => f.level)).toEqual(['warning', 'warning']);

    acknowledgeDivergence(h.state, divergences(out)[1], 'evt-1');
    expect(divergences(h.windows([14, 16].map((m) => ({ gap: m * MiB, rate: MiB }))))).toEqual([]);
  });

  it('raises the seconds-behind ceiling to warning, then critical', () => {
    const h = new Harness();
    const rate = 0.1 * MiB;
    const warn = divergences(h.windows([{ gap: 5 * MiB, rate }, { gap: 5 * MiB, rate }, { gap: 5 * MiB, rate }]));
    expect(warn[0]).toMatchObject({ level: 'warning', reason: 'ceiling' });

    const crit = divergences(
      h.windows([{ gap: 15 * MiB, rate }, { gap: 15 * MiB, rate }, { gap: 15 * MiB, rate }]),
    );
    expect(crit[0]).toMatchObject({ level: 'critical', reason: 'ceiling' });
  });

  it('escalates when the gap does not close after write pressure subsides', () => {
    const h = new Harness();
    h.windows([0, 0, 0].map(() => ({ gap: 0, rate: MiB })));
    const burst = divergences(h.windows([22, 24, 26, 28].map((m) => ({ gap: m * MiB, rate: 4 * MiB }))));
    expect(burst.map((f) => [f.level, f.reason])).toEqual([['warning', 'growth']]);

    const subsided = divergences(h.windows(Array.from({ length: 6 }, () => ({ gap: 28 * MiB, rate: MiB }))));
    expect(subsided).toHaveLength(1);
    expect(subsided[0]).toMatchObject({ level: 'critical', reason: 'not_catching_up' });
  });

  it('does not escalate when the gap halves after the burst', () => {
    const h = new Harness();
    h.windows([0, 0, 0].map(() => ({ gap: 0, rate: MiB })));
    h.windows([22, 24, 26, 28].map((m) => ({ gap: m * MiB, rate: 4 * MiB })));

    const after = h.windows([28, 20, 12, 6, 6, 6].map((m) => ({ gap: m * MiB, rate: MiB })));
    expect(divergences(after)).toEqual([]);
  });

  it('does not raise the ceiling on a burst that drains after writes drop', () => {
    const h = new Harness();
    const out = h.windows([
      { gap: 60 * MiB, rate: 10 * MiB },
      { gap: 40 * MiB, rate: 0.1 * MiB },
      { gap: 20 * MiB, rate: 0.1 * MiB },
      { gap: 5 * MiB, rate: 0.1 * MiB },
      { gap: 0, rate: 0.1 * MiB },
      { gap: 0, rate: 0.1 * MiB },
    ]);
    expect(divergences(out)).toEqual([]);
  });

  it('raises the ceiling on a gap that shrinks too slowly to matter', () => {
    const h = new Harness();
    const findings = divergences(h.windows([600, 599, 598, 597].map((m) => ({ gap: m * MiB, rate: MiB }))));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ level: 'critical', reason: 'ceiling' });
  });

  it('does not escalate a steady drain that will clear soon', () => {
    const h = new Harness();
    h.windows([0, 0, 0].map(() => ({ gap: 0, rate: MiB })));
    h.windows([22, 24, 26, 28].map((m) => ({ gap: m * MiB, rate: 4 * MiB })));

    const draining = h.windows([28, 25, 22, 19, 16, 13, 10, 7].map((m) => ({ gap: m * MiB, rate: MiB })));
    expect(divergences(draining)).toEqual([]);
  });

  it('escalates a drain too slow to clear within the horizon', () => {
    const h = new Harness();
    h.windows([0, 0, 0].map(() => ({ gap: 0, rate: MiB })));
    h.windows([22, 24, 26, 28].map((m) => ({ gap: m * MiB, rate: 4 * MiB })));

    const crawling = divergences(h.windows([28, 27, 26, 25, 24, 23].map((m) => ({ gap: m * MiB, rate: MiB }))));
    expect(crawling).toHaveLength(1);
    expect(crawling[0]).toMatchObject({ level: 'critical', reason: 'not_catching_up' });
  });

  it('keeps an active finding open while the replica ack goes stale', () => {
    const h = new Harness();
    h.windows([2, 4, 6, 8, 8].map((m) => ({ gap: m * MiB, rate: MiB })));

    const stale = h.windows([{ gap: 10 * MiB, rate: MiB, lagSec: 30 }]);
    expect(stale.flat()).toEqual([]);
    expect(h.state.replicas.get(ADDR)?.level).toBe('warning');

    const gone = h.windows([{ gap: 0, rate: MiB, present: false }, { gap: 0, rate: MiB, present: false }]);
    expect(gone.flat().map((o) => o.kind)).toEqual(['cleared']);
  });

  it('escalates an active finding whose ack stays stale under a raised repl-timeout', () => {
    const h = new Harness();
    h.windows([2, 4, 6, 8, 8].map((m) => ({ gap: m * MiB, rate: MiB })));

    const stale = divergences(
      h.windows(Array.from({ length: 5 }, (_, i) => ({ gap: 10 * MiB, rate: MiB, lagSec: climbingLag(i) }))),
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ level: 'critical', reason: 'not_acking', gapBytes: 10 * MiB });
  });

  it('recovers a not-acking alert once a stale replica is no longer behind', () => {
    const h = new Harness();
    const opened = divergences(
      h.windows(Array.from({ length: 8 }, (_, i) => ({ gap: 40 * MiB, rate: MiB, lagSec: climbingLag(i) }))),
    );
    expect(opened.map((f) => f.reason)).toContain('not_acking');

    const recovered = h
      .windows(Array.from({ length: DIVERGENCE_RECOVERED_WINDOWS + 1 }, (_, i) => ({ gap: 0, rate: MiB, lagSec: climbingLag(8 + i) })))
      .flat();

    expect(recovered.map((o) => o.kind)).toEqual(['recovered']);
  });

  it('keeps a not-acking alert open while one window dips under the floor', () => {
    const h = new Harness();
    h.windows(Array.from({ length: 8 }, (_, i) => ({ gap: 40 * MiB, rate: MiB, lagSec: climbingLag(i) })));

    const outcomes = h
      .windows([
        { gap: 0, rate: MiB, lagSec: climbingLag(8) },
        { gap: 40 * MiB, rate: MiB, lagSec: climbingLag(9) },
        { gap: 0, rate: MiB, lagSec: climbingLag(10) },
      ])
      .flat();

    expect(outcomes.map((o) => o.kind)).not.toContain('recovered');
  });

  it('flags a replica that stops acking while it looked healthy', () => {
    const h = new Harness();
    const rate = 0.2 * MiB;
    h.windows([0, 0, 0].map(() => ({ gap: 0, rate })));

    const stale = h.windows(
      [2, 4, 6, 8, 10].map((m, i) => ({ gap: m * MiB, rate, lagSec: climbingLag(i) })),
    );
    expect(divergences(stale).map((f) => [f.level, f.reason, f.gapBytes / MiB])).toEqual([
      ['warning', 'not_acking', 4],
      ['critical', 'not_acking', 8],
    ]);
  });

  it('warns at most once before the default repl-timeout drops a stalled replica', () => {
    const h = new Harness();
    h.windows([0, 0, 0].map(() => ({ gap: 0, rate: MiB })));

    const out = h.windows([
      { gap: 30 * MiB, rate: MiB, lagSec: 25 },
      { gap: 60 * MiB, rate: MiB, lagSec: 55 },
      { gap: 0, rate: MiB, present: false },
      { gap: 0, rate: MiB, present: false },
    ]);

    expect(out.flat().map((o) => (o.kind === 'divergence' ? o.level : o.kind))).toEqual([
      'warning',
      'cleared',
    ]);
  });

  it('stays quiet on a stale ack whose gap is under the floor at the current write rate', () => {
    const h = new Harness();
    const out = h.windows(
      Array.from({ length: 6 }, (_, i) => ({ gap: MiB - 1, rate: MiB, lagSec: climbingLag(i) })),
    );
    expect(out.flat()).toEqual([]);
  });

  it('stays quiet on a stale ack only seconds behind a fast primary', () => {
    const h = new Harness();
    const out = h.windows(
      Array.from({ length: 6 }, (_, i) => ({ gap: 8 * MiB, rate: 4 * MiB, lagSec: climbingLag(i) })),
    );
    expect(out.flat()).toEqual([]);
  });

  it('counts stale windows only while the replica is behind', () => {
    const h = new Harness();
    const out = h.windows(
      [40 * MiB, 0, 40 * MiB].map((gap, i) => ({ gap, rate: MiB, lagSec: climbingLag(i) })),
    );
    expect(divergences(out)).toEqual([]);
  });

  it('raises no alert for a disconnect the last-IO path owns', () => {
    const h = new Harness();
    h.windows([0, 0, 0].map(() => ({ gap: 0, rate: 1024 })));

    const out = h.windows([
      { gap: 40_000, rate: 1024, lagSec: 25 },
      { gap: 70_000, rate: 1024, lagSec: 55 },
      { gap: 0, rate: 1024, state: 'wait_bgsave' },
      { gap: 0, rate: 1024, present: false },
    ]);

    expect(out.flat()).toEqual([]);
  });

  describe('a replica that acks only now and then', () => {
    const sporadic = (h: Harness, windows: number, lags = [[0, 20, 20]]): DivergenceOutcome[] => {
      const outcomes: DivergenceOutcome[] = [];
      for (let w = 0; w < windows; w++) {
        for (const lagSec of lags[w % lags.length]) {
          const spec = { gap: 50 * MiB, rate: 0.1 * MiB, lagSec };
          const emitted = observeDivergence(h.state, h.sample(spec), WINDOW_MS);
          for (const o of emitted) {
            if (o.kind === 'divergence') acknowledgeDivergence(h.state, o, `evt-${o.level}`);
          }
          outcomes.push(...emitted);
          h.t += POLL_MS;
        }
      }
      return outcomes;
    };

    it('alerts when one tracked sample and two stale ones fill each window', () => {
      const h = new Harness();

      const findings = divergences([sporadic(h, 6)]);

      expect(findings.map((f) => [f.level, f.reason])).toEqual([
        ['warning', 'not_acking'],
        ['critical', 'not_acking'],
      ]);
    });

    it('judges the gap, not the ack, on one stale sample in each window', () => {
      const h = new Harness();

      const findings = divergences([sporadic(h, 6, [[0, 11, 0]])]);

      expect(findings.map((f) => [f.level, f.reason])).toEqual([['critical', 'ceiling']]);
    });

    it('restarts the count when a window is not mostly stale', () => {
      const h = new Harness();

      const lags = [
        [0, 20, 20],
        [0, 0, 20],
      ];
      expect(divergences([sporadic(h, 8, lags)])).toEqual([]);
    });

    it('recovers under the floor with one stale sample in each window', () => {
      const h = new Harness();
      sporadic(h, 6);

      const outcomes: DivergenceOutcome[] = [];
      for (let w = 0; w < 4; w++) {
        for (const lagSec of [0, 20, 0]) {
          outcomes.push(...h.poll({ gap: 0.1 * MiB, rate: 0.1 * MiB, lagSec }, POLL_MS));
        }
      }

      expect(outcomes[0]).toMatchObject({ kind: 'recovered', addr: ADDR });
    });
  });

  describe('recovery while the write rate spikes', () => {
    const SPIKE = 100 * MiB;
    const growing = [20, 22, 24, 26, 28].map((m) => ({ gap: m * MiB, rate: MiB }));
    const recoveries = (outcomes: DivergenceOutcome[][]) =>
      outcomes.flat().filter((o) => o.kind === 'recovered');

    it('keeps the alert open while the gap grows behind a rate spike', () => {
      const h = new Harness();
      const opened = h.windows(growing);
      const spike = h.windows([30, 32, 34].map((m) => ({ gap: m * MiB, rate: SPIKE })));
      const after = h.windows([{ gap: 36 * MiB, rate: MiB }]);

      expect(divergences(opened)).toHaveLength(1);
      expect(recoveries([...spike, ...after])).toEqual([]);
      expect(divergences([...spike, ...after])).toEqual([]);
    });

    it('does not count a window of growth toward recovery', () => {
      const h = new Harness();
      h.windows(growing);
      const outcomes = h.windows([
        { gap: 27 * MiB, rate: SPIKE },
        { gap: 29 * MiB, rate: SPIKE },
        { gap: 28 * MiB, rate: SPIKE },
      ]);

      expect(recoveries(outcomes)).toEqual([]);
    });

    it('recovers above the floor once the gap shrinks', () => {
      const h = new Harness();
      h.windows(growing);
      const outcomes = h.windows([
        { gap: 27 * MiB, rate: SPIKE },
        { gap: 26 * MiB, rate: SPIKE },
        { gap: 25 * MiB, rate: SPIKE },
      ]);

      expect(recoveries(outcomes)).toHaveLength(1);
    });

    it('recovers above the floor on a flat gap under the thresholds', () => {
      const h = new Harness();
      h.windows(growing);
      const outcomes = h.windows(Array.from({ length: 4 }, () => ({ gap: 28 * MiB, rate: SPIKE })));

      expect(recoveries(outcomes)).toHaveLength(1);
    });

    it('recovers a not-acking alert on a flat stale gap under the thresholds', () => {
      const h = new Harness();
      h.windows(
        Array.from({ length: 8 }, (_, i) => ({ gap: 40 * MiB, rate: MiB, lagSec: climbingLag(i) })),
      );
      const outcomes = h.windows(
        Array.from({ length: 3 }, (_, i) => ({ gap: 40 * MiB, rate: SPIKE, lagSec: climbingLag(8 + i) })),
      );

      expect(recoveries(outcomes)).toHaveLength(1);
    });

    it('keeps a not-acking alert open while its stale gap grows', () => {
      const h = new Harness();
      const opened = h.windows(
        Array.from({ length: 8 }, (_, i) => ({ gap: 40 * MiB, rate: MiB, lagSec: climbingLag(i) })),
      );
      const spike = h.windows(
        [42, 44, 46].map((m, i) => ({ gap: m * MiB, rate: SPIKE, lagSec: climbingLag(8 + i) })),
      );

      expect(divergences(opened).map((f) => f.reason)).toContain('not_acking');
      expect(recoveries(spike)).toEqual([]);
    });

    it('does not count growth from before a recovery toward the next alert', () => {
      const h = new Harness();
      h.windows(growing);
      const recovered = h.windows([0.1, 0.2, 0.3].map((m) => ({ gap: m * MiB, rate: MiB })));
      const regrowth = h.windows([2, 3, 4].map((m) => ({ gap: m * MiB, rate: 0.1 * MiB })));

      expect(recoveries(recovered)).toHaveLength(1);
      expect(divergences(regrowth)).toEqual([]);
    });
  });

  describe('a replica draining after writes stop', () => {
    const drain = (from: number, step: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({ gap: (from - step * i) * MiB, rate: 0 }));

    it('does not call a steady slow drain not applying', () => {
      const h = new Harness();

      expect(divergences(h.windows(drain(100, 5, 19)))).toEqual([]);
    });

    it('keeps an open alert below critical through a slow drain', () => {
      const h = new Harness();
      const opened = h.windows([20, 22, 24, 26, 28].map((m) => ({ gap: m * MiB, rate: MiB })));
      const draining = h.windows(drain(28, 1, 12));

      expect(divergences(opened)).toHaveLength(1);
      expect(divergences(draining)).toEqual([]);
    });

    it('calls a drain that stalls not applying', () => {
      const h = new Harness();
      const out = h.windows([...drain(100, 5, 3), ...drain(90, 0, 6)]);

      expect(divergences(out).map((f) => f.reason)).toEqual(['not_applying']);
    });
  });

  describe('the write-rate baseline', () => {
    const history = (h: Harness) => h.state.rateHistory;
    const demoted = (t: number): ReplicationStreamSample => ({
      timestamp: t,
      role: 'replica',
      replid: 'a'.repeat(40),
      masterReplOffset: 0,
      bytesPerSec: 0,
      bytesPerSecEwma: 0,
      replBacklogSize: null,
      replicas: [],
    });

    it('does not call writes subsided without a baseline', () => {
      const h = new Harness();
      const outcomes = h.windows([
        ...[20, 22, 24, 26, 28].map((m) => ({ gap: m * MiB, rate: 4 * MiB })),
        { gap: 28 * MiB, rate: 0.1 * MiB },
        ...Array.from({ length: 6 }, () => ({ gap: 28 * MiB, rate: MiB })),
      ]);

      expect(divergences(outcomes).map((f) => f.reason)).not.toContain('not_catching_up');
    });

    it('does not read a resumed burst as subsided after a dip', () => {
      const h = new Harness();
      const outcomes = h.windows([
        ...[20, 22, 24, 26, 28].map((m) => ({ gap: m * MiB, rate: 4 * MiB })),
        { gap: 28 * MiB, rate: 0.1 * MiB },
        ...Array.from({ length: 6 }, () => ({ gap: 28 * MiB, rate: 4 * MiB })),
      ]);

      expect(divergences(outcomes).at(-1)?.reason).not.toBe('not_catching_up');
    });

    it('starts over when the node stops being a primary', () => {
      const h = new Harness();
      h.windows([0, 0, 0].map(() => ({ gap: 0, rate: MiB })));
      expect(history(h).length).toBeGreaterThan(0);

      observeDivergence(h.state, demoted(h.t), WINDOW_MS);

      expect(history(h)).toEqual([]);
    });

    it('starts over when the replication id changes', () => {
      const h = new Harness();
      h.windows([0, 0, 0].map(() => ({ gap: 0, rate: MiB })));

      const restarted = { ...h.sample({ gap: 0, rate: 2 * MiB }), replid: 'b'.repeat(40) };
      observeDivergence(h.state, restarted, WINDOW_MS);

      expect(history(h)).not.toContain(MiB);
    });

    it('drops the baseline held by an open alert when the replication id changes', () => {
      const h = new Harness();
      h.windows([0, 0, 0].map(() => ({ gap: 0, rate: 0.5 * MiB })));
      h.windows([22, 24, 26, 28].map((m) => ({ gap: m * MiB, rate: 4 * MiB })));
      expect(h.state.replicas.get(ADDR)?.baselineRate).not.toBeNull();

      const restarted = { ...h.sample({ gap: 28 * MiB, rate: 4 * MiB }), replid: 'b'.repeat(40) };
      observeDivergence(h.state, restarted, WINDOW_MS);

      expect(h.state.replicas.get(ADDR)?.baselineRate).toBeNull();
    });
  });

  it('flags a stale ack with a real gap while the primary takes no writes', () => {
    const h = new Harness();
    const out = h.windows(
      Array.from({ length: 6 }, (_, i) => ({ gap: 2 * MiB, rate: 0, lagSec: climbingLag(i) })),
    );
    expect(divergences(out).map((f) => [f.level, f.reason, f.secondsBehind])).toEqual([
      ['warning', 'not_acking', null],
      ['critical', 'not_acking', null],
    ]);
  });

  it('flags a stale ack with a real gap while the write rate is unknown', () => {
    const h = new Harness();
    const out = h.windows(
      Array.from({ length: 6 }, (_, i) => ({ gap: 2 * MiB, rate: null, lagSec: climbingLag(i) })),
    );
    expect(divergences(out).map((f) => [f.level, f.reason, f.secondsBehind])).toEqual([
      ['warning', 'not_acking', null],
      ['critical', 'not_acking', null],
    ]);
  });

  it('stays quiet on a stale ack below the floor while the primary takes no writes', () => {
    const h = new Harness();
    const out = h.windows(Array.from({ length: 6 }, () => ({ gap: MiB - 1, rate: 0, lagSec: 30 })));
    expect(out.flat()).toEqual([]);
  });

  it('does not judge the ceiling across an untracked window', () => {
    const h = new Harness();
    const out = h.windows([
      { gap: 125 * MiB, rate: MiB },
      { gap: 125 * MiB, rate: MiB, lagSec: 30 },
      { gap: 130 * MiB, rate: MiB },
      { gap: 0, rate: MiB },
      { gap: 0, rate: MiB },
    ]);
    expect(divergences(out)).toEqual([]);
  });

  it('does not count below-floor windows on both sides of a stale period', () => {
    const h = new Harness();
    h.windows([2, 4, 6, 8, 0].map((m) => ({ gap: m * MiB, rate: MiB })));

    const out = h.windows([
      { gap: 0, rate: MiB, lagSec: 30 },
      { gap: 0, rate: MiB },
      { gap: 0, rate: MiB },
      { gap: 0, rate: MiB },
    ]);
    expect(out.map((w) => w.map((o) => o.kind))).toEqual([[], [], [], ['recovered']]);
  });

  it('restarts the recovery grace when tracking resumes after a stale ack', () => {
    const h = new Harness();
    h.windows([0, 0, 0].map(() => ({ gap: 0, rate: MiB })));
    h.windows([22, 24, 26, 28].map((m) => ({ gap: m * MiB, rate: 4 * MiB })));
    h.windows([28, 28, 28].map((m) => ({ gap: m * MiB, rate: MiB })));
    h.windows([{ gap: 28 * MiB, rate: MiB, lagSec: 30 }]);

    const resumed = h.windows(Array.from({ length: 6 }, () => ({ gap: 28 * MiB, rate: MiB })));
    expect(resumed.map((w) => divergences([w]).map((f) => f.reason))).toEqual([[], [], [], [], [], ['not_catching_up']]);
  });

  it('escalates on gap alone when writes stop and the replica applies nothing', () => {
    const h = new Harness();
    const out = h.windows(Array.from({ length: 6 }, () => ({ gap: 4 * MiB, rate: 0 })));
    const findings = divergences(out);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      level: 'critical',
      reason: 'not_applying',
      gapBytes: 4 * MiB,
      secondsBehind: null,
    });
  });

  it('treats an unknown write rate like stopped writes, never as infinite lag', () => {
    const h = new Harness();
    const out = h.windows(Array.from({ length: 6 }, () => ({ gap: 4 * MiB, rate: null })));
    const [finding] = divergences(out);
    expect(finding.reason).toBe('not_applying');
    expect(Number.isFinite(finding.secondsBehind ?? 0)).toBe(true);
  });

  describe('writes that stop, through the real sample stream', () => {
    const PING_BYTES = 14;

    class Stream {
      readonly state = createDivergenceState();
      private readonly tracker = new ReplicationStreamTracker();
      private t = 1_700_000_000_000;
      primary = 1_000_000_000;
      replica = 1_000_000_000;
      lag = 0;

      poll(wroteBytes: number, appliedBytes: number): DivergenceOutcome[] {
        this.t += POLL_MS;
        this.primary += wroteBytes;
        this.replica += appliedBytes;
        const sample = this.tracker.observe(
          'conn-1',
          {
            role: 'master',
            master_repl_offset: String(this.primary),
            master_replid: 'a'.repeat(40),
            slave0: `ip=10.0.0.2,port=6379,state=online,offset=${this.replica},lag=${this.lag}`,
          },
          this.t,
        );
        const emitted = observeDivergence(this.state, sample as ReplicationStreamSample, WINDOW_MS);
        for (const o of emitted) {
          if (o.kind === 'divergence') acknowledgeDivergence(this.state, o, `evt-${o.level}`);
        }
        return emitted;
      }

      writing(polls: number): void {
        for (let i = 0; i < polls; i++) this.poll(10 * MiB, 10 * MiB);
      }

      stopped(polls: number): DivergenceOutcome[] {
        return Array.from({ length: polls }, () => this.poll(PING_BYTES, 0)).flat();
      }
    }

    it('reports a replica that applies nothing after writes stop', () => {
      const s = new Stream();
      s.writing(9);
      s.poll(4 * MiB, 0);

      const findings = divergences([s.stopped(60)]);

      expect(findings.map((f) => f.reason)).not.toContain('ceiling');
      expect(findings[findings.length - 1]).toMatchObject({
        level: 'critical',
        reason: 'not_applying',
        secondsBehind: null,
      });
    });

    it('stays quiet through a burst that drains, then warns on a gap that keeps growing', () => {
      const s = new Stream();
      s.writing(9);

      const burst = [
        ...Array.from({ length: 6 }, () => s.poll(6 * MiB, 0)).flat(),
        ...Array.from({ length: 6 }, () => s.poll(0, 6 * MiB)).flat(),
      ];
      expect(burst).toEqual([]);

      s.writing(9);
      const sustained = divergences([Array.from({ length: 18 }, () => s.poll(11 * MiB, 10 * MiB)).flat()]);
      expect(sustained.map((f) => [f.level, f.reason])).toEqual([['warning', 'growth']]);
    });

    it('reports a replica that stops acking under a raised repl-timeout', () => {
      const s = new Stream();
      s.writing(9);
      s.poll(4 * MiB, 0);
      s.lag = 30;

      const findings = divergences([
        Array.from({ length: 60 }, (_, i) => {
          s.lag = 11 + i * (POLL_MS / 1000);
          return s.poll(14, 0);
        }).flat(),
      ]);

      expect(findings.map((f) => [f.level, f.reason, f.secondsBehind])).toEqual([
        ['warning', 'not_acking', null],
        ['critical', 'not_acking', null],
      ]);
      expect(describeDivergence(findings[1])).not.toContain('write rate');
    });

    it('stays quiet on a stale ack with nothing left to send', () => {
      const s = new Stream();
      s.writing(9);
      s.lag = 30;

      expect(divergences([s.stopped(60)])).toEqual([]);
    });

    it('still counts occasional writes in a window as writing', () => {
      const s = new Stream();
      s.writing(9);
      s.poll(4 * MiB, 0);
      s.stopped(30);
      s.poll(MiB, MiB);
      s.stopped(2);

      const [window] = s.state.replicas.get(ADDR)?.windows.slice(-1) ?? [];
      expect(window.bytesPerSec).toBeGreaterThan(0);
      expect(window.secondsBehind).not.toBeNull();
    });
  });

  it('reports recovery after two windows below the floor', () => {
    const h = new Harness();
    h.windows([2, 4, 6, 8, 0].map((m) => ({ gap: m * MiB, rate: MiB })));

    const recovery = h.windows([{ gap: 0, rate: MiB }, { gap: 0, rate: MiB }]).flat();
    expect(recovery).toEqual([{ kind: 'recovered', addr: ADDR, eventId: 'evt-warning', gapBytes: 0 }]);
    expect(h.windows([{ gap: 0, rate: MiB }, { gap: 0, rate: MiB }]).flat()).toEqual([]);
  });

  it('skips replicas that are not online', () => {
    const h = new Harness();
    const syncing = h.windows([2, 4, 6, 8, 10].map((m) => ({ gap: m * MiB, rate: MiB, state: 'send_bulk' })));
    expect(syncing.flat()).toEqual([]);
  });

  it('clears an active replica that drops out instead of reporting recovery', () => {
    const h = new Harness();
    h.windows([2, 4, 6, 8, 8].map((m) => ({ gap: m * MiB, rate: MiB })));

    const gone = h.windows([{ gap: 0, rate: MiB, present: false }, { gap: 0, rate: MiB, present: false }]);
    expect(gone.flat()).toEqual([{ kind: 'cleared', addr: ADDR, eventId: 'evt-warning', gapBytes: null }]);
  });

  describe('a replica with no fresh sample', () => {
    const quiet = () => {
      const h = new Harness();
      h.windows([{ gap: 0, rate: MiB }, { gap: 0, rate: MiB }]);
      return { h, last: h.state.lastSampleAt as number };
    };

    it('reports a replica behind under the alert thresholds as behind', () => {
      const h = new Harness();
      h.windows([{ gap: 8 * MiB, rate: MiB }, { gap: 8 * MiB, rate: MiB }]);
      const last = h.state.lastSampleAt as number;

      expect(h.state.replicas.get(ADDR)?.level).toBe('none');
      expect(replicaObservedLevel(h.state, ADDR, last, 30_000)).toBe('behind');

      h.windows([{ gap: 0, rate: MiB }, { gap: 0, rate: MiB }]);
      expect(replicaObservedLevel(h.state, ADDR, h.state.lastSampleAt as number, 30_000)).toBe('none');
    });

    it('stays in sync while samples are within the limit', () => {
      const { h, last } = quiet();

      expect(replicaObservedLevel(h.state, ADDR, last + 30_000, 30_000)).toBe('none');
    });

    it('is unobserved once the last sample is older than the limit', () => {
      const { h, last } = quiet();

      expect(replicaObservedLevel(h.state, ADDR, last + 30_001, 30_000)).toBe('unobserved');
    });

    it('keeps an open alert level', () => {
      const h = new Harness();
      h.windows([2, 4, 6, 8, 10].map((gap) => ({ gap: gap * MiB, rate: MiB })));
      const last = h.state.lastSampleAt as number;

      expect(replicaObservedLevel(h.state, ADDR, last + 1_000_000, 30_000)).toBe('warning');
    });

    it('stays observed while a connected replica stops acknowledging', () => {
      const { h, last } = quiet();

      h.windows([{ gap: 0, rate: MiB, lagSec: 30 }]);

      expect(h.state.replicas.get(ADDR)?.level ?? 'none').toBe('none');
      expect(replicaObservedLevel(h.state, ADDR, last, 1_000_000)).toBe('none');
    });

    it('is behind while a connected replica stops acknowledging with a gap', () => {
      const h = new Harness();
      h.windows([{ gap: 0, rate: MiB }, { gap: 0, rate: MiB }]);

      h.windows([{ gap: 40 * MiB, rate: MiB, lagSec: 30 }]);
      const last = h.state.lastSampleAt as number;

      expect(h.state.replicas.get(ADDR)?.level ?? 'none').toBe('none');
      expect(replicaObservedLevel(h.state, ADDR, last, 1_000_000)).toBe('behind');
    });

    it('is unobserved once the samples of a stale replica stop', () => {
      const h = new Harness();
      h.windows([{ gap: 40 * MiB, rate: MiB, lagSec: 30 }]);
      const last = h.state.lastSampleAt as number;

      expect(replicaObservedLevel(h.state, ADDR, last + 30_001, 30_000)).toBe('unobserved');
    });

    it('gives the current gap of a stale replica, not its last window', () => {
      const h = new Harness();
      h.windows([{ gap: 0, rate: MiB }, { gap: 0, rate: MiB }]);

      h.windows([{ gap: 8 * MiB, rate: MiB, lagSec: 30 }]);

      expect(staleAckWindow(h.state, ADDR)?.gapBytes).toBe(8 * MiB);
    });

    it('has no stale gap for a replica that is acknowledging', () => {
      const { h } = quiet();

      expect(staleAckWindow(h.state, ADDR)).toBeNull();
    });

    it('is in sync again once acknowledgements resume', () => {
      const { h, last } = quiet();

      h.windows([{ gap: 0, rate: MiB, lagSec: 30 }]);
      h.windows([{ gap: 0, rate: MiB }]);

      expect(replicaObservedLevel(h.state, ADDR, last, 1_000_000)).toBe('none');
    });

    it('leaves observation untouched for restart orphans', () => {
      const { h, last } = quiet();

      replicaObservedLevel(h.state, ADDR, last + 1_000_000, 30_000);

      expect(h.state.observed.has(ADDR)).toBe(true);
    });
  });

  it('writes a gap below 1 KiB in bytes', () => {
    const message = describeDivergence({
      kind: 'divergence',
      addr: ADDR,
      level: 'warning',
      reason: 'not_acking',
      gapBytes: 400,
      secondsBehind: null,
      bytesPerSec: null,
      slopeBytesPerWindow: 0,
      windowCount: 2,
      spanStart: 0,
    });

    expect(message).toContain('is 400 B behind');
  });

  it('keeps emitting cleared for a dropped replica until it is acknowledged', () => {
    const h = new Harness();
    h.windows([2, 4, 6, 8, 8].map((m) => ({ gap: m * MiB, rate: MiB })));

    const absent = { gap: 0, rate: MiB, present: false };
    const unacked = h.windows([absent, absent, absent], false);
    expect(unacked.flat().map((o) => o.kind)).toEqual(['cleared', 'cleared']);

    acknowledgeRecovery(h.state, ADDR);
    expect(h.windows([absent, absent]).flat()).toEqual([]);
    expect(h.state.replicas.size).toBe(0);
  });

  it('starts a fresh series when a cleared replica comes back', () => {
    const h = new Harness();
    h.windows([2, 4, 6, 8, 8].map((m) => ({ gap: m * MiB, rate: MiB })));
    h.windows([{ gap: 0, rate: MiB, present: false }]);

    const back = h.windows([10, 12, 14, 16].map((m) => ({ gap: m * MiB, rate: MiB })));
    expect(divergences(back)).toEqual([]);
  });

  it('clears active findings when the node stops being a primary', () => {
    const h = new Harness();
    h.windows([2, 4, 6, 8, 8].map((m) => ({ gap: m * MiB, rate: MiB })));

    const demoted = (): ReplicationStreamSample => ({
      timestamp: 1_800_000_000_000,
      role: 'replica',
      replid: null,
      masterReplOffset: 0,
      bytesPerSec: MiB,
      bytesPerSecEwma: MiB,
      replBacklogSize: null,
      replicas: [],
    });
    expect(observeDivergence(h.state, demoted(), WINDOW_MS)).toEqual([
      { kind: 'cleared', addr: ADDR, eventId: 'evt-warning', gapBytes: null },
    ]);
    expect(observeDivergence(h.state, demoted(), WINDOW_MS)).toHaveLength(1);

    acknowledgeRecovery(h.state, ADDR);
    expect(observeDivergence(h.state, demoted(), WINDOW_MS)).toEqual([]);
    expect(h.state.replicas.size).toBe(0);
    expect(h.state.windowStart).toBeNull();
  });
});

describe('requeueClosedWindows', () => {
  const closed = (end: number): ClosedDivergenceWindow => ({
    addr: ADDR,
    start: end - WINDOW_MS,
    end,
    gapBytes: 0,
    bytesPerSec: null,
    secondsBehind: null,
  });

  it('drops the oldest windows first when the backlog is full', () => {
    const state = createDivergenceState();
    const failed = Array.from({ length: DIVERGENCE_PERSIST_BACKLOG }, (_, i) => closed(i));
    state.closedWindows = [closed(DIVERGENCE_PERSIST_BACKLOG), closed(DIVERGENCE_PERSIST_BACKLOG + 1)];

    requeueClosedWindows(state, failed);

    const ends = drainClosedWindows(state).map((w) => w.end);
    expect(ends).toHaveLength(DIVERGENCE_PERSIST_BACKLOG);
    expect(ends[0]).toBe(2);
    expect(ends[ends.length - 1]).toBe(DIVERGENCE_PERSIST_BACKLOG + 1);
  });
});

describe("the replica's own view", () => {
  const ok = (gapBytes: number, primaryGapBytes: number, linkUp = true): ReplicaViewReading => ({
    status: 'ok',
    gapBytes,
    linkUp,
    primaryGapBytes,
  });

  class ViewHarness extends Harness {
    reading: ReplicaViewReading | undefined = undefined;

    viewWindow(spec: WindowSpec): DivergenceOutcome[] {
      const outcomes: DivergenceOutcome[] = [];
      for (let i = 0; i < WINDOW_MS / POLL_MS; i++) {
        const before = this.state.closedWindowCount;
        let emitted = observeDivergence(this.state, this.sample(spec), WINDOW_MS);
        if (this.state.closedWindowCount !== before) {
          const readings = new Map(this.reading ? [[ADDR, this.reading]] : []);
          emitted = applyReplicaViews(this.state, emitted, readings);
        }
        for (const o of emitted) {
          if (o.kind === 'divergence') acknowledgeDivergence(this.state, o, `evt-${o.level}`);
          else if (o.kind === 'views_disagree') acknowledgeViewDisagreement(this.state, o.addr, 'evt-views');
          else if (o.kind === 'views_agree') acknowledgeViewAgreement(this.state, o.addr, o.eventId);
          else acknowledgeRecovery(this.state, o.addr);
        }
        outcomes.push(...emitted);
        this.t += POLL_MS;
      }
      return outcomes;
    }

    viewWindows(count: number, spec: WindowSpec): DivergenceOutcome[] {
      return Array.from({ length: count }, () => this.viewWindow(spec)).flat();
    }
  }

  const kinds = (outcomes: DivergenceOutcome[]) => outcomes.map((o) => o.kind);

  it('stores both views on the closed windows', () => {
    const h = new ViewHarness();
    h.reading = ok(MiB / 2, 2 * MiB);
    h.viewWindows(3, { gap: 2 * MiB, rate: MiB });

    const drained = drainClosedWindows(h.state);
    expect(drained.length).toBeGreaterThan(0);
    expect(drained.every((w) => w.replicaView === 'ok' && w.replicaGapBytes === MiB / 2)).toBe(true);
    expect(h.state.replicas.get(ADDR)!.windows.at(-1)).toMatchObject({ replicaGapBytes: MiB / 2, replicaView: 'ok' });
  });

  it('marks a window the replica could not confirm without a replica gap', () => {
    const h = new ViewHarness();
    h.reading = { status: 'replid_mismatch', gapBytes: null, linkUp: false, primaryGapBytes: null };
    h.viewWindows(3, { gap: 2 * MiB, rate: MiB });

    expect(h.state.replicas.get(ADDR)!.windows.at(-1)).toMatchObject({
      replicaGapBytes: null,
      replicaView: 'replid_mismatch',
    });
  });

  it('ignores a disagreement that lasts a single window', () => {
    const h = new ViewHarness();
    h.reading = ok(0, 0);
    h.viewWindows(3, { gap: 0, rate: MiB });
    h.reading = ok(20 * MiB, 0);
    const blip = h.viewWindow({ gap: 0, rate: MiB });
    h.reading = ok(0, 0);
    const after = h.viewWindows(3, { gap: 0, rate: MiB });

    expect(kinds([...blip, ...after])).not.toContain('views_disagree');
  });

  it(`reports views that disagree for ${DIVERGENCE_DISAGREE_WINDOWS} windows in a row once`, () => {
    const h = new ViewHarness();
    h.reading = ok(20 * MiB, 0);
    const outcomes = h.viewWindows(DIVERGENCE_DISAGREE_WINDOWS + 3, { gap: 0, rate: MiB });

    const disagreements = outcomes.filter((o): o is ViewDisagreement => o.kind === 'views_disagree');
    expect(disagreements).toHaveLength(1);
    expect(disagreements[0]).toMatchObject({
      addr: ADDR,
      primaryGapBytes: 0,
      replicaGapBytes: 20 * MiB,
      windowCount: DIVERGENCE_DISAGREE_WINDOWS,
    });
    expect(describeViewDisagreement(disagreements[0])).toContain(
      'the primary is tracking an offset the replica no longer has',
    );
    expect(h.state.replicas.get(ADDR)!.disagreeEventId).toBe('evt-views');
  });

  it('does not count a difference a few seconds of writes would cover', () => {
    const h = new ViewHarness();
    h.reading = ok(10 * MiB, 0);
    const outcomes = h.viewWindows(DIVERGENCE_DISAGREE_WINDOWS + 2, { gap: 0, rate: 10 * MiB });

    expect(kinds(outcomes)).not.toContain('views_disagree');
  });

  it(`clears the disagreement after ${DIVERGENCE_RECOVERED_WINDOWS} windows that do not confirm it`, () => {
    const h = new ViewHarness();
    h.reading = ok(0, 20 * MiB);
    const raised = h.viewWindows(DIVERGENCE_DISAGREE_WINDOWS + 1, { gap: 20 * MiB, rate: MiB });
    expect(kinds(raised)).toContain('views_disagree');

    h.reading = { status: 'unreachable', gapBytes: null, linkUp: false, primaryGapBytes: null };
    const first = h.viewWindow({ gap: 0, rate: MiB });
    expect(kinds(first)).not.toContain('views_agree');
    h.reading = ok(0, 0);
    const second = h.viewWindow({ gap: 0, rate: MiB });

    expect(second.filter((o) => o.kind === 'views_agree')).toEqual([
      { kind: 'views_agree', addr: ADDR, eventId: 'evt-views' },
    ]);
    expect(h.state.replicas.get(ADDR)?.disagreeEventId ?? null).toBeNull();
  });

  it('holds back recovery while the replica still reports it is behind', () => {
    const h = new ViewHarness();
    h.windows(Array.from({ length: 10 }, () => ({ gap: 400 * MiB, rate: 10 * MiB })));
    expect(h.state.replicas.get(ADDR)!.level).not.toBe('none');

    h.reading = ok(400 * MiB, 0);
    const held = h.viewWindows(DIVERGENCE_RECOVERED_WINDOWS + 1, { gap: 0, rate: 10 * MiB });
    expect(kinds(held)).not.toContain('recovered');

    h.reading = ok(0, 0, false);
    expect(kinds(h.viewWindow({ gap: 0, rate: 10 * MiB }))).not.toContain('recovered');

    h.reading = ok(0, 0);
    expect(kinds(h.viewWindow({ gap: 0, rate: 10 * MiB }))).toContain('recovered');
  });

  it('confirms recovery from the primary alone when the replica cannot be read', () => {
    const h = new ViewHarness();
    h.windows(Array.from({ length: 10 }, () => ({ gap: 400 * MiB, rate: 10 * MiB })));

    const outcomes = h.viewWindows(DIVERGENCE_RECOVERED_WINDOWS + 1, { gap: 0, rate: 10 * MiB });

    expect(kinds(outcomes)).toContain('recovered');
  });

  it('resolves the disagreement when the replica drops out', () => {
    const h = new ViewHarness();
    h.reading = ok(20 * MiB, 0);
    h.viewWindows(DIVERGENCE_DISAGREE_WINDOWS + 1, { gap: 0, rate: MiB });

    const dropped = h.viewWindows(2, { gap: 0, rate: MiB, present: false });

    expect(dropped.filter((o) => o.kind === 'views_agree')).toEqual([
      { kind: 'views_agree', addr: ADDR, eventId: 'evt-views' },
    ]);
  });

  it('samples every replica with a fresh window', () => {
    const h = new ViewHarness();
    h.viewWindows(2, { gap: 0, rate: MiB });

    expect(replicasToSample(h.state, [])).toEqual([ADDR]);
    expect(replicaEventIds(h.state.replicas.get(ADDR)!)).toEqual([]);
  });
});
