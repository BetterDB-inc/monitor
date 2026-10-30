import {
  acknowledgeRetryAmplificationFinding,
  createRetryAmplificationState,
  describeRetryAmplificationState,
  evaluateRetryAmplification,
  readRetryAmplificationTrigger,
  RetryAmplificationFinding,
  RetryAmplificationState,
  RETRY_AMP_WINDOW_MS,
} from '../retry-amplification-detector';
import { MetricType } from '../types';

interface WindowSpec {
  ops: number;
  clients: number;
  cmdsPerClient: number;
  errorsPerSec?: number;
  churn?: number | null;
  p99?: boolean;
  saturation?: MetricType;
}

const BASE: WindowSpec = {
  ops: 1000,
  clients: 100,
  cmdsPerClient: 10,
  errorsPerSec: 0.1,
  churn: 0.2,
};

function hot(multiplier: number, extra: Partial<WindowSpec> = {}): WindowSpec {
  return {
    ops: BASE.ops * multiplier,
    clients: BASE.clients,
    cmdsPerClient: BASE.cmdsPerClient * multiplier,
    errorsPerSec: BASE.errorsPerSec,
    churn: BASE.churn,
    p99: true,
    ...extra,
  };
}

class Driver {
  state: RetryAmplificationState = createRetryAmplificationState();
  t = 0;
  commands = 1_000_000;
  errors = 0;
  findings: RetryAmplificationFinding[] = [];
  ack = true;

  window(spec: WindowSpec): void {
    const start = this.t;
    const events = [];
    if (spec.p99) events.push({ metricType: MetricType.COMMAND_P99, timestamp: start + 5_000 });
    if (spec.saturation) events.push({ metricType: spec.saturation, timestamp: start + 10_000 });
    for (let i = 0; i < RETRY_AMP_WINDOW_MS / 1000; i++) {
      this.commands += spec.cmdsPerClient * spec.clients;
      this.errors += spec.errorsPerSec ?? 0;
      this.poll(spec, events);
      this.t += 1000;
    }
  }

  windows(spec: WindowSpec, count: number): void {
    for (let i = 0; i < count; i++) this.window(spec);
  }

  baseline(count = 12): void {
    this.windows(BASE, count);
  }

  poll(
    spec: WindowSpec,
    events: Array<{ metricType: MetricType; timestamp: number }> = [],
    commands: number = this.commands,
  ): RetryAmplificationFinding | null {
    const finding = evaluateRetryAmplification(this.state, {
      timestamp: this.t,
      opsPerSec: spec.ops,
      connectedClients: spec.clients,
      totalCommands: commands,
      totalErrorReplies: spec.errorsPerSec === undefined ? null : Math.round(this.errors),
      connectsPerSec: spec.churn === undefined ? null : spec.churn,
      recentEvents: events,
    });
    if (finding !== null) {
      if (!this.findings.includes(finding)) this.findings.push(finding);
      if (this.ack) acknowledgeRetryAmplificationFinding(this.state, finding);
    }
    return finding;
  }
}

describe('retry amplification detector', () => {
  it('stays quiet while the baseline is still arming', () => {
    const d = new Driver();
    d.windows(BASE, 5);
    d.windows(hot(2), 5);
    d.window(BASE);
    expect(d.findings).toHaveLength(0);
  });

  it('classifies a short latency spike that recovers as transient', () => {
    const d = new Driver();
    d.baseline();
    d.windows(hot(1.6), 2);
    d.windows(BASE, 2);
    expect(d.findings).toHaveLength(0);
    expect(d.state.lastEpisode?.classification).toBe('transient');
    expect(d.state.lastEpisode?.windows).toBe(2);
  });

  it('raises a warning for sustained co-rising load and P99 with flat clients', () => {
    const d = new Driver();
    d.baseline();
    d.window(hot(1.5));
    d.window(hot(1.7));
    d.window(hot(1.9));
    d.window(hot(2.0));
    expect(d.findings).toHaveLength(1);
    const f = d.findings[0];
    expect(f.level).toBe('warning');
    expect(f.trigger).toBe('latency');
    expect(f.windows).toBe(3);
    expect(f.loadRatio).toBeCloseTo(1.9, 1);
    expect(f.correlation).toBeGreaterThanOrEqual(0.5);
    expect(f.relatedMetrics).toEqual([MetricType.COMMAND_P99]);
    expect(f.message).toContain('Retry amplification');
    expect(readRetryAmplificationTrigger(f.message)).toBe('a latency regression (COMMAND_P99)');
  });

  it('escalates to critical when a saturation event lands in the episode', () => {
    const d = new Driver();
    d.baseline();
    d.window(hot(1.5));
    d.window(hot(1.7, { saturation: MetricType.LOAD_SATURATION }));
    d.window(hot(1.9));
    d.window(hot(2.0));
    expect(d.findings).toHaveLength(1);
    expect(d.findings[0].level).toBe('critical');
    expect(d.findings[0].relatedMetrics).toContain(MetricType.LOAD_SATURATION);
  });

  it('escalates warning to critical within one episode and emits once per level', () => {
    const d = new Driver();
    d.baseline();
    d.windows(hot(1.6), 4);
    d.window(hot(1.8, { saturation: MetricType.CPU_UTILIZATION }));
    d.windows(hot(1.8), 3);
    expect(d.findings.map((f) => f.level)).toEqual(['warning', 'critical']);
  });

  it('ignores traffic growth that comes from new clients', () => {
    const d = new Driver();
    d.baseline();
    d.windows(hot(2, { clients: 200, cmdsPerClient: 20 }), 5);
    d.window(BASE);
    expect(d.findings).toHaveLength(0);
    expect(d.state.lastEpisode).toBeNull();
  });

  it('ignores an error burst without load growth', () => {
    const d = new Driver();
    d.baseline();
    d.windows({ ...BASE, errorsPerSec: 50, p99: true }, 5);
    d.window(BASE);
    expect(d.findings).toHaveLength(0);
  });

  it('ignores load growth without any stress signal', () => {
    const d = new Driver();
    d.baseline();
    d.windows(hot(2, { p99: false }), 5);
    d.window(BASE);
    expect(d.findings).toHaveLength(0);
  });

  it('does not flag load that decays after three hot windows', () => {
    const d = new Driver();
    d.baseline();
    d.window(hot(2.4));
    d.window(hot(2.0));
    d.window(hot(1.6));
    d.window(hot(1.4));
    d.window(BASE);
    expect(d.findings).toHaveLength(0);
    d.windows(BASE, 2);
    expect(d.state.lastEpisode?.classification).toBe('unconfirmed');
  });

  it('classifies from error bursts when P99 events are absent', () => {
    const d = new Driver();
    d.baseline();
    d.window(hot(1.5, { p99: false, errorsPerSec: 5 }));
    d.window(hot(1.7, { p99: false, errorsPerSec: 10 }));
    d.window(hot(1.9, { p99: false, errorsPerSec: 20 }));
    d.window(hot(2.0, { p99: false, errorsPerSec: 30 }));
    expect(d.findings).toHaveLength(1);
    expect(d.findings[0].trigger).toBe('errors');
  });

  it('classifies from churn and names it as the trigger', () => {
    const d = new Driver();
    d.baseline();
    d.windows(hot(1.6, { p99: false, churn: 5 }), 4);
    expect(d.findings).toHaveLength(1);
    expect(d.findings[0].trigger).toBe('churn');
    expect(d.findings[0].relatedMetrics).toEqual([MetricType.CONNECTION_CHURN]);
  });

  it('still classifies from stress alone when the churn input is absent', () => {
    const d = new Driver();
    const noChurn = { ...BASE, churn: undefined };
    d.windows(noChurn, 12);
    d.windows(hot(1.6, { churn: undefined }), 4);
    expect(d.findings).toHaveLength(1);
    expect(d.findings[0].trigger).toBe('latency');
  });

  it('names the earliest stress leg as the trigger', () => {
    const d = new Driver();
    d.baseline();
    d.window(hot(1.5, { p99: false, errorsPerSec: 5 }));
    d.window(hot(1.7));
    d.window(hot(1.9));
    d.window(hot(2.0));
    expect(d.findings[0].trigger).toBe('errors');
  });

  it('keeps returning an unacknowledged finding every poll', () => {
    const d = new Driver();
    d.ack = false;
    d.baseline();
    d.windows(hot(1.6), 4);
    const finding = d.poll(hot(1.6));
    expect(finding).not.toBeNull();
    d.t += 1000;
    expect(d.poll(hot(1.6))).toBe(finding);
    acknowledgeRetryAmplificationFinding(d.state, finding!);
    d.t += 1000;
    expect(d.poll(hot(1.6))).toBeNull();
  });

  it('re-arms after two cold windows and fires again on a new episode', () => {
    const d = new Driver();
    d.baseline();
    d.windows(hot(1.6), 4);
    d.window(BASE);
    d.windows(hot(1.6), 2);
    expect(d.findings).toHaveLength(1);
    d.windows(BASE, 3);
    expect(d.state.lastEpisode?.classification).toBe('amplifying');
    d.windows(hot(1.6), 4);
    expect(d.findings).toHaveLength(2);
  });

  it('lowers the acknowledged level on de-escalation so critical can fire again', () => {
    const d = new Driver();
    d.baseline();
    d.windows(hot(1.6, { saturation: MetricType.LOAD_SATURATION }), 4);
    d.window(hot(1.6));
    expect(d.state.ackedLevel).toBe('critical');
    d.state.hotRun = d.state.hotRun.map((w) => ({ ...w, saturationMetrics: [] }));
    d.window(hot(1.6));
    expect(d.state.ackedLevel).toBe('warning');
    d.window(hot(1.6, { saturation: MetricType.LOAD_SATURATION }));
    d.window(hot(1.6));
    expect(d.findings.map((f) => f.level)).toEqual(['critical', 'critical']);
  });

  it('freezes the baseline while an episode is open', () => {
    const d = new Driver();
    d.baseline();
    d.window(hot(1.6));
    const before = d.state.coldWindows.map((w) => w.start);
    d.windows(hot(1.6), 6);
    expect(d.state.coldWindows.map((w) => w.start)).toEqual(before);
  });

  it('clears windows and the episode on a command counter reset', () => {
    const d = new Driver();
    d.baseline();
    d.windows(hot(1.6), 2);
    d.t += 1000;
    d.poll(BASE, [], 10);
    expect(d.state.hotRun).toHaveLength(0);
    expect(d.state.coldWindows).toHaveLength(0);
    expect(d.state.pending).toBeNull();
  });

  it('skips windows with too little coverage', () => {
    const d = new Driver();
    for (let i = 0; i < 12; i++) {
      d.poll(BASE);
      d.t += RETRY_AMP_WINDOW_MS;
    }
    expect(d.state.coldWindows).toHaveLength(0);
  });

  describe('describeRetryAmplificationState', () => {
    it('reports an unknown connection as unarmed with no episode', () => {
      expect(describeRetryAmplificationState(undefined)).toEqual({
        armed: false,
        classification: 'none',
        level: 'none',
        windows: 0,
        baseline: null,
        lastEpisode: null,
      });
    });

    it('reports a fresh state as unarmed', () => {
      expect(describeRetryAmplificationState(createRetryAmplificationState())).toEqual(
        expect.objectContaining({ armed: false, classification: 'none', baseline: null }),
      );
    });
  });
});
