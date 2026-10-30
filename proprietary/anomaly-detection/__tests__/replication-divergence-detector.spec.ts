import {
  ClosedDivergenceWindow,
  DIVERGENCE_MIN_WINDOW_MS,
  DIVERGENCE_PERSIST_BACKLOG,
  DivergenceConnectionState,
  DivergenceFinding,
  DivergenceOutcome,
  acknowledgeDivergence,
  acknowledgeRecovery,
  createDivergenceState,
  divergenceWindowMs,
  drainClosedWindows,
  observeDivergence,
  requeueClosedWindows,
} from '../replication-divergence-detector';
import { ReplicaOffset, ReplicationStreamSample } from '../replication-stream';

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
}

class Harness {
  readonly state: DivergenceConnectionState = createDivergenceState();
  private t = 1_700_000_000_000;

  private sample(spec: WindowSpec): ReplicationStreamSample {
    const replicas: ReplicaOffset[] =
      spec.present === false
        ? []
        : [
            {
              key: 'slave0',
              addr: ADDR,
              state: spec.state ?? 'online',
              offset: 0,
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
      replBacklogHistlen: null,
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

  windows(specs: WindowSpec[], ack = true): DivergenceOutcome[][] {
    return specs.map((spec) => this.window(spec, ack));
  }
}

function divergences(outcomes: DivergenceOutcome[][]): DivergenceFinding[] {
  return outcomes.flat().filter((o): o is DivergenceFinding => o.kind === 'divergence');
}

describe('divergenceWindowMs', () => {
  it('uses 30s or three poll intervals, whichever is longer', () => {
    expect(divergenceWindowMs(1000)).toBe(DIVERGENCE_MIN_WINDOW_MS);
    expect(divergenceWindowMs(15_000)).toBe(45_000);
  });
});

describe('observeDivergence', () => {
  it('ignores samples from replicas', () => {
    const state = createDivergenceState();
    const sample: ReplicationStreamSample = {
      timestamp: 0,
      role: 'replica',
      replid: null,
      masterReplOffset: 0,
      bytesPerSec: 1,
      bytesPerSecEwma: 1,
      replBacklogHistlen: null,
      replicas: [],
    };
    expect(observeDivergence(state, sample, WINDOW_MS)).toEqual([]);
  });

  it('stays quiet through a write burst that recovers', () => {
    const h = new Harness();
    const out = h.windows(
      [2, 4, 6, 4, 2, 0, 0].map((m) => ({ gap: m * MiB, rate: MiB })),
    );
    expect(out.flat()).toEqual([]);
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

  it('escalates an active finding whose ack stays stale', () => {
    const h = new Harness();
    h.windows([2, 4, 6, 8, 8].map((m) => ({ gap: m * MiB, rate: MiB })));

    const stale = divergences(h.windows(Array.from({ length: 5 }, () => ({ gap: 10 * MiB, rate: MiB, lagSec: 30 }))));
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ level: 'critical', reason: 'not_acking', gapBytes: 10 * MiB });
  });

  it('flags a replica that stops acking while it looked healthy', () => {
    const h = new Harness();
    h.windows([0, 0, 0].map(() => ({ gap: 0, rate: MiB })));

    const stale = h.windows([2, 4, 6, 8, 10].map((m) => ({ gap: m * MiB, rate: MiB, lagSec: 30 })));
    expect(divergences(stale).map((f) => [f.level, f.reason, f.gapBytes / MiB])).toEqual([
      ['warning', 'not_acking', 4],
      ['critical', 'not_acking', 8],
    ]);
  });

  it('stays quiet on a stale ack while the primary takes no writes', () => {
    const h = new Harness();
    const out = h.windows(Array.from({ length: 6 }, () => ({ gap: 2 * MiB, rate: 0, lagSec: 30 })));
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

  it('keeps emitting cleared when an unacknowledged replica returns with a stale ack', () => {
    const h = new Harness();
    h.windows([2, 4, 6, 8, 8].map((m) => ({ gap: m * MiB, rate: MiB })));

    const returned = h.windows(
      [
        { gap: 0, rate: MiB, present: false },
        ...Array.from({ length: 6 }, () => ({ gap: 10 * MiB, rate: MiB, lagSec: 30 })),
      ],
      false,
    );
    expect(returned.flat().every((o) => o.kind === 'cleared')).toBe(true);
    expect(returned.flat()).toHaveLength(6);

    acknowledgeRecovery(h.state, ADDR);
    const stale = divergences(h.windows(Array.from({ length: 3 }, () => ({ gap: 10 * MiB, rate: MiB, lagSec: 30 }))));
    expect(stale.map((f) => [f.level, f.reason])).toEqual([['warning', 'not_acking']]);
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
      replBacklogHistlen: null,
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
