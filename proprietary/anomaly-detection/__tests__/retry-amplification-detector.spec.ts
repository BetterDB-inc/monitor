import {
  acknowledgeRetryAmplificationFinding,
  createRetryAmplificationState,
  retryAmplificationMaxPollGap,
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
  lateP99?: boolean;
  saturation?: MetricType;
  stressActive?: boolean;
  activeSaturation?: MetricType[];
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
  carried: Array<{ metricType: MetricType; timestamp: number }> = [];
  pollMs = 1000;

  window(spec: WindowSpec): void {
    const start = this.t;
    const events = this.carried;
    this.carried = [];
    if (spec.lateP99) {
      this.carried.push({ metricType: MetricType.COMMAND_P99, timestamp: start + 59_500 });
    } else if (spec.p99) {
      events.push({ metricType: MetricType.COMMAND_P99, timestamp: start + 5_000 });
    }
    if (spec.saturation) events.push({ metricType: spec.saturation, timestamp: start + 10_000 });
    const seconds = this.pollMs / 1000;
    for (let i = 0; i < RETRY_AMP_WINDOW_MS / this.pollMs; i++) {
      this.commands += spec.cmdsPerClient * spec.clients * seconds;
      this.errors += (spec.errorsPerSec ?? 0) * seconds;
      this.poll(spec, events);
      this.t += this.pollMs;
    }
  }

  windows(spec: WindowSpec, count: number): void {
    for (let i = 0; i < count; i++) this.window(spec);
  }

  baseline(count = 12): void {
    this.windows(BASE, count);
  }

  ramp(count: number, extra: Partial<WindowSpec> = {}, from = 1.5): void {
    for (let i = 0; i < count; i++) this.window(hot(from + i * 0.15, extra));
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
      stressActive: spec.stressActive,
      activeSaturation: spec.activeSaturation,
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
    expect(f.pattern).toBe('rising');
    expect(f.correlation).toBeGreaterThanOrEqual(0.5);
    expect(f.relatedMetrics).toEqual([MetricType.COMMAND_P99]);
    expect(f.message).toContain('Retry amplification');
    expect(readRetryAmplificationTrigger(f.message)).toBe('a latency regression (COMMAND_P99)');
  });

  it('escalates to critical when a saturation event lands in the episode', () => {
    const d = new Driver();
    d.baseline();
    d.window(hot(1.5));
    d.window(hot(1.7));
    d.window(hot(1.9, { saturation: MetricType.LOAD_SATURATION }));
    d.window(hot(2.0));
    expect(d.findings).toHaveLength(1);
    expect(d.findings[0].level).toBe('critical');
    expect(d.findings[0].relatedMetrics).toContain(MetricType.LOAD_SATURATION);
  });

  it('escalates warning to critical within one episode and emits once per level', () => {
    const d = new Driver();
    d.baseline();
    d.ramp(4);
    d.window(hot(2.1, { saturation: MetricType.CPU_UTILIZATION }));
    d.ramp(3, {}, 2.2);
    expect(d.findings.map((f) => f.level)).toEqual(['warning', 'critical']);
  });

  it('drops back to warning once saturation clears and re-emits critical when it returns', () => {
    const d = new Driver();
    d.baseline();
    d.window(hot(1.5));
    d.window(hot(1.65));
    d.window(hot(1.8, { saturation: MetricType.LOAD_SATURATION }));
    d.ramp(2, {}, 1.95);
    d.window(hot(2.25, { saturation: MetricType.LOAD_SATURATION }));
    d.window(hot(2.4));
    expect(d.findings.map((f) => f.level)).toEqual(['critical', 'critical']);
  });

  it('keeps following the latest window once the load shape fades', () => {
    const d = new Driver();
    d.baseline();
    d.ramp(4);
    d.window(hot(1.6, { saturation: MetricType.LOAD_SATURATION }));
    d.windows(hot(1.6), 2);
    expect(d.findings.map((f) => f.level)).toEqual(['warning', 'critical']);
    expect(d.state.ackedLevel).toBe('warning');
  });

  it('counts a P99 event that lands after the window has already rolled over', () => {
    const d = new Driver();
    d.baseline();
    d.window(hot(1.5, { lateP99: true }));
    d.window(hot(1.7, { lateP99: true }));
    d.window(hot(1.9, { lateP99: true }));
    d.window(hot(2.0, { lateP99: true }));
    expect(d.findings).toHaveLength(1);
    expect(d.findings[0].trigger).toBe('latency');
    expect(d.findings[0].relatedMetrics).toContain(MetricType.COMMAND_P99);
  });

  it('does not flag flat elevated load under a latency regression', () => {
    const d = new Driver();
    d.baseline();
    d.windows(hot(1.6), 6);
    expect(d.findings).toHaveLength(0);
  });

  it('flags load that steps up under retry errors and holds there', () => {
    const d = new Driver();
    d.baseline();
    d.window(hot(2.2, { errorsPerSec: 5 }));
    d.window(hot(2.1, { errorsPerSec: 5 }));
    d.window(hot(2.15, { errorsPerSec: 5 }));
    d.window(hot(2.2, { errorsPerSec: 5 }));
    expect(d.findings).toHaveLength(1);
    expect(d.findings[0].level).toBe('warning');
    expect(d.findings[0].pattern).toBe('step');
    expect(d.findings[0].correlation).toBeNull();
    expect(d.findings[0].message).toContain('stepped up under stress');
    expect(d.findings[0].message).not.toContain('r=');
  });

  it('flags a storm that overshoots and then settles on a plateau', () => {
    const d = new Driver();
    d.baseline();
    d.window(hot(3.0, { errorsPerSec: 5 }));
    d.windows(hot(2.5, { errorsPerSec: 5 }), 4);
    expect(d.findings).toHaveLength(1);
    expect(d.findings[0].pattern).toBe('step');
  });

  it('does not treat a latency-only step as retries', () => {
    const d = new Driver();
    d.baseline();
    d.windows(hot(2.2), 5);
    expect(d.findings).toHaveLength(0);
  });

  it('does not flag a step that is already falling back', () => {
    const d = new Driver();
    d.baseline();
    d.window(hot(3.0, { errorsPerSec: 5 }));
    d.window(hot(2.6, { errorsPerSec: 5 }));
    d.window(hot(2.2, { errorsPerSec: 5 }));
    d.window(hot(1.8, { errorsPerSec: 5 }));
    expect(d.findings).toHaveLength(0);
  });

  it('needs a real load rise before trusting a three-window correlation', () => {
    const d = new Driver();
    d.baseline();
    d.window(hot(1.5, { p99: false, stressActive: true }));
    d.window(hot(1.6, { p99: false, stressActive: true }));
    d.window(hot(1.55, { p99: false, stressActive: true }));
    d.window(BASE);
    expect(d.findings).toHaveLength(0);
  });

  it('does not flag rising load next to a flat error rate without latency stress', () => {
    const d = new Driver();
    d.baseline();
    d.ramp(5, { p99: false, errorsPerSec: 20 });
    expect(d.findings).toHaveLength(0);
  });

  it('treats an ongoing P99 regression as stress in every window it covers', () => {
    const d = new Driver();
    d.baseline();
    d.ramp(4, { p99: false, stressActive: true });
    expect(d.findings).toHaveLength(1);
    expect(d.findings[0].trigger).toBe('latency');
    expect(d.findings[0].message).toContain('sustained latency regression');
  });

  it('reports critical when saturation started before the episode and is still active', () => {
    const d = new Driver();
    d.baseline();
    d.ramp(4, { activeSaturation: [MetricType.LOAD_SATURATION] });
    expect(d.findings).toHaveLength(1);
    expect(d.findings[0].level).toBe('critical');
  });

  it('keeps working when the poll interval is longer than the default gap', () => {
    const slow = new Driver();
    slow.pollMs = 20_000;
    slow.state = createRetryAmplificationState(retryAmplificationMaxPollGap(20_000));
    slow.baseline();
    slow.ramp(4);
    expect(slow.findings).toHaveLength(1);

    const fixed = new Driver();
    fixed.pollMs = 20_000;
    fixed.baseline();
    fixed.ramp(4);
    expect(fixed.findings).toHaveLength(0);
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
    for (let i = 0; i < 4; i++) d.window(hot(1.5 + i * 0.15, { p99: false, churn: 3 + i * 2 }));
    expect(d.findings).toHaveLength(1);
    expect(d.findings[0].trigger).toBe('churn');
    expect(d.findings[0].relatedMetrics).toEqual([MetricType.CONNECTION_CHURN]);
  });

  it('still classifies from stress alone when the churn input is absent', () => {
    const d = new Driver();
    const noChurn = { ...BASE, churn: undefined };
    d.windows(noChurn, 12);
    d.ramp(4, { churn: undefined });
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
    d.ramp(4);
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
    d.ramp(4);
    d.window(BASE);
    d.ramp(2, {}, 2.1);
    expect(d.findings).toHaveLength(1);
    d.windows(BASE, 3);
    expect(d.state.lastEpisode?.classification).toBe('amplifying');
    d.ramp(4);
    expect(d.findings).toHaveLength(2);
  });

  it('lowers the acknowledged level on de-escalation so critical can fire again', () => {
    const d = new Driver();
    d.baseline();
    d.ramp(4, { saturation: MetricType.LOAD_SATURATION });
    d.window(hot(2.1));
    expect(d.state.ackedLevel).toBe('critical');
    d.window(hot(2.2));
    expect(d.state.ackedLevel).toBe('warning');
    d.window(hot(2.3, { saturation: MetricType.LOAD_SATURATION }));
    d.window(hot(2.4));
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
});
