import {
  IncidentTimelineBuilder,
  RecoveryProbe,
  incidentIdFor,
  incidentStartOf,
  matchSequence,
  mergeRuleSteps,
  reachesStep,
  toTimelineEntry,
} from '../incident-timeline';
import { SequenceRule } from '../sequence-rules';
import { AnomalyEvent, AnomalyPattern, AnomalySeverity, AnomalyType, MetricType } from '../types';

const T0 = 1_700_000_000_000;
const MIN = 60_000;

let seq = 0;
function event(overrides: Partial<AnomalyEvent> = {}): AnomalyEvent {
  seq++;
  return {
    id: `evt-${String(seq).padStart(3, '0')}`,
    timestamp: T0,
    metricType: MetricType.MEMORY_USED,
    anomalyType: AnomalyType.SPIKE,
    severity: AnomalySeverity.WARNING,
    value: 1,
    baseline: 0,
    stdDev: 0,
    zScore: 4,
    threshold: 3,
    message: 'msg',
    resolved: false,
    connectionId: 'conn-a',
    ...overrides,
  };
}

const neverRecovers: RecoveryProbe = () => null;
const recoversAfterQuiet: RecoveryProbe = ({ since }) => since + MIN;

const escalation: SequenceRule = {
  pattern: AnomalyPattern.MEMORY_PRESSURE,
  steps: [[MetricType.CONNECTIONS], [MetricType.MEMORY_USED, MetricType.FRAGMENTATION_RATIO]],
  maxSpanMs: 10 * MIN,
  diagnosis: 'Connections led to memory growth',
  recommendations: ['Check clients'],
};

describe('IncidentTimelineBuilder', () => {
  beforeEach(() => {
    seq = 0;
  });

  describe('stored boundaries', () => {
    const boundary = (startedAt: number, anomalyId: string, scopeId = 'conn-a') => ({
      scopeId,
      startedAt,
      anomalyId,
    });

    it('splits at a stored boundary inside a continuous chain', () => {
      const first = event({ timestamp: T0 });
      const second = event({ timestamp: T0 + MIN });

      const incidents = new IncidentTimelineBuilder().build(
        [first, second],
        T0 + 2 * MIN,
        neverRecovers,
        [boundary(T0, first.id), boundary(T0 + MIN, second.id)],
      );

      expect(incidents.map((i) => i.entries.map((e) => e.anomalyId))).toEqual([
        [first.id],
        [second.id],
      ]);
    });

    it('keeps the stored start when a same timestamp sibling outlives its event', () => {
      const sibling = event({ id: 'a-sibling', timestamp: T0 });
      const tail = event({ id: 'b-tail', timestamp: T0 + MIN });

      const incidents = new IncidentTimelineBuilder().build(
        [sibling, tail],
        T0 + 2 * MIN,
        neverRecovers,
        [boundary(T0, 'z-gone')],
      );

      expect(incidents.map((i) => i.incidentId)).toEqual([incidentIdFor('conn-a', 'z-gone', T0)]);
      expect(incidents[0].entries.map((e) => e.anomalyId)).toEqual([sibling.id, tail.id]);
    });

    it('keeps the stored start when only a same timestamp sibling is left', () => {
      const sibling = event({ id: 'a-sibling', timestamp: T0 });

      const [incident] = new IncidentTimelineBuilder().build(
        [sibling],
        T0 + MIN,
        neverRecovers,
        [boundary(T0, 'z-gone')],
      );

      expect(incident.incidentId).toBe(incidentIdFor('conn-a', 'z-gone', T0));
    });

    it('keeps the stored start when the early events are no longer held', () => {
      const late = event({ id: 'late', timestamp: T0 + 10 * MIN });

      const [incident] = new IncidentTimelineBuilder().build(
        [late],
        T0 + 11 * MIN,
        neverRecovers,
        [boundary(T0, 'z-gone')],
        new Map([['conn-a', T0 + 9 * MIN]]),
      );

      expect(incidentStartOf(incident.incidentId)).toBe(T0);
    });

    it('keeps the stored start when a dropped span covers its first event', () => {
      const late = event({ id: 'late', timestamp: T0 + 10 * MIN });

      const [incident] = new IncidentTimelineBuilder().build(
        [late],
        T0 + 11 * MIN,
        neverRecovers,
        [boundary(T0, 'z-gone')],
        new Map(),
        Number.NEGATIVE_INFINITY,
        new Map([['conn-a', [{ from: T0 - MIN, through: T0 + 9 * MIN, scopeId: 'conn-a' }]]]),
      );

      expect(incidentStartOf(incident.incidentId)).toBe(T0);
    });

    it('keeps the stored start across dropped spans chained from another connection', () => {
      const late = event({ id: 'late', timestamp: T0 + 20 * MIN });

      const [incident] = new IncidentTimelineBuilder({}, () => 'cluster').build(
        [late],
        T0 + 21 * MIN,
        neverRecovers,
        [boundary(T0, 'z-gone', 'cluster')],
        new Map(),
        Number.NEGATIVE_INFINITY,
        new Map([
          ['conn-a', [{ from: T0 - MIN, through: T0 + 9 * MIN, scopeId: 'cluster' }]],
          ['conn-b', [{ from: T0 + 10 * MIN, through: T0 + 19 * MIN, scopeId: 'cluster' }]],
        ]),
      );

      expect(incidentStartOf(incident.incidentId)).toBe(T0);
    });

    it('starts afresh when no drop reached the stored start', () => {
      const late = event({ id: 'late', timestamp: T0 + 10 * MIN });

      const [incident] = new IncidentTimelineBuilder().build(
        [late],
        T0 + 11 * MIN,
        neverRecovers,
        [boundary(T0, 'z-gone')],
        new Map(),
        Number.NEGATIVE_INFINITY,
        new Map([['conn-a', [{ from: T0 + MIN, through: T0 + 9 * MIN, scopeId: 'conn-a' }]]]),
      );

      expect(incidentStartOf(incident.incidentId)).toBe(T0 + 10 * MIN);
    });

    it('bridges a gap through a dropped span that runs past the next event', () => {
      const first = event({ timestamp: T0 });
      const inside = event({ timestamp: T0 + 20 * MIN, metricType: MetricType.COMMAND_P99 });

      const incidents = new IncidentTimelineBuilder().build(
        [first, inside],
        T0 + 31 * MIN,
        neverRecovers,
        [],
        new Map(),
        Number.NEGATIVE_INFINITY,
        new Map([['conn-a', [{ from: T0 + MIN, through: T0 + 30 * MIN, scopeId: 'conn-a' }]]]),
      );

      expect(incidents).toHaveLength(1);
    });

    it('ignores an unscoped dropped span from a connection outside the scope', () => {
      const first = event({ timestamp: T0 });
      const late = event({ timestamp: T0 + 20 * MIN });

      const incidents = new IncidentTimelineBuilder().build(
        [first, late],
        T0 + 21 * MIN,
        neverRecovers,
        [],
        new Map(),
        Number.NEGATIVE_INFINITY,
        new Map([['conn-z', [{ from: T0 + MIN, through: T0 + 19 * MIN }]]]),
      );

      expect(incidents).toHaveLength(2);
    });

    it('bridges a gap through adjacent dropped spans from two connections', () => {
      const first = event({ timestamp: T0 });
      const late = event({ timestamp: T0 + 30 * MIN, connectionId: 'conn-b' });

      const incidents = new IncidentTimelineBuilder({}, () => 'cluster').build(
        [first, late],
        T0 + 31 * MIN,
        neverRecovers,
        [],
        new Map(),
        Number.NEGATIVE_INFINITY,
        new Map([
          ['conn-a', [{ from: T0 + MIN, through: T0 + 14 * MIN, scopeId: 'cluster' }]],
          ['conn-b', [{ from: T0 + 15 * MIN, through: T0 + 29 * MIN, scopeId: 'cluster' }]],
        ]),
      );

      expect(incidents).toHaveLength(1);
    });

    it('starts afresh when the dropped events ended before the gap', () => {
      const late = event({ id: 'late', timestamp: T0 + 10 * MIN });

      const [incident] = new IncidentTimelineBuilder().build(
        [late],
        T0 + 11 * MIN,
        neverRecovers,
        [boundary(T0, 'z-gone')],
        new Map([['conn-a', T0 + MIN]]),
      );

      expect(incidentStartOf(incident.incidentId)).toBe(T0 + 10 * MIN);
    });

    it('keeps the stored start when the held window passed the early events', () => {
      const late = event({ id: 'late', timestamp: T0 + 10 * MIN });

      const [incident] = new IncidentTimelineBuilder().build(
        [late],
        T0 + 70 * MIN,
        neverRecovers,
        [boundary(T0, 'z-gone')],
        new Map(),
        T0 + 10 * MIN,
      );

      expect(incidentStartOf(incident.incidentId)).toBe(T0);
    });

    it('starts afresh when a new event follows the held window by more than the gap', () => {
      const late = event({ id: 'late', timestamp: T0 + 10 * MIN });

      const [incident] = new IncidentTimelineBuilder().build(
        [late],
        T0 + 70 * MIN,
        neverRecovers,
        [boundary(T0, 'z-gone')],
        new Map(),
        T0 + 5 * MIN,
      );

      expect(incidentStartOf(incident.incidentId)).toBe(T0 + 10 * MIN);
    });

    it('keeps the stored start when another node of the scope dropped the events', () => {
      const late = event({ id: 'late', timestamp: T0 + 10 * MIN, connectionId: 'conn-b' });

      const [incident] = new IncidentTimelineBuilder({}, () => 'cluster').build(
        [late],
        T0 + 11 * MIN,
        neverRecovers,
        [boundary(T0, 'z-gone', 'cluster')],
        new Map([['conn-a', T0 + 9 * MIN]]),
      );

      expect(incidentStartOf(incident.incidentId)).toBe(T0);
    });

    it('ignores events dropped from another scope', () => {
      const late = event({ id: 'late', timestamp: T0 + 10 * MIN });

      const [incident] = new IncidentTimelineBuilder().build(
        [late],
        T0 + 11 * MIN,
        neverRecovers,
        [boundary(T0, 'z-gone')],
        new Map([['conn-b', T0 + 9 * MIN]]),
      );

      expect(incidentStartOf(incident.incidentId)).toBe(T0 + 10 * MIN);
    });

    it('splits same timestamp boundaries in event order, not id order', () => {
      const first = event({ id: 'z-first', timestamp: T0, eventSequence: 1 });
      const second = event({ id: 'a-second', timestamp: T0, eventSequence: 2 });

      const incidents = new IncidentTimelineBuilder().build(
        [first, second],
        T0 + MIN,
        neverRecovers,
        [boundary(T0, second.id), boundary(T0, first.id)],
      );

      expect(incidents.map((i) => i.entries.map((e) => e.anomalyId)).sort()).toEqual([
        [second.id],
        [first.id],
      ]);
    });

    it('holds a same timestamp boundary back until its own event', () => {
      const head = event({ id: 'a-head', timestamp: T0 - MIN });
      const before = event({ id: 'b-before', timestamp: T0 });
      const own = event({ id: 'c-own', timestamp: T0 });

      const incidents = new IncidentTimelineBuilder().build(
        [head, before, own],
        T0 + MIN,
        neverRecovers,
        [boundary(T0 - MIN, head.id), boundary(T0, own.id)],
      );

      expect(incidents.map((i) => i.entries.map((e) => e.anomalyId))).toEqual([
        [head.id, before.id],
        [own.id],
      ]);
    });

    it('keeps the id and start of an incident whose head left the window', () => {
      const head = event({ timestamp: T0 });
      const tail = event({ timestamp: T0 + MIN });
      const builder = new IncidentTimelineBuilder();
      const boundaries = [boundary(T0, head.id)];

      const [whole] = builder.build([head, tail], T0 + 2 * MIN, neverRecovers, boundaries);
      const [cut] = builder.build([tail], T0 + 2 * MIN, neverRecovers, boundaries);

      expect(cut.incidentId).toBe(whole.incidentId);
      expect(cut.startedAt).toBe(T0);
      expect(cut.entries.map((e) => e.anomalyId)).toEqual([tail.id]);
    });

    it('counts the span cap from the stored start', () => {
      const head = event({ timestamp: T0 });
      const inside = event({ timestamp: T0 + MIN });
      const past = event({ timestamp: T0 + 31 * MIN });

      const incidents = new IncidentTimelineBuilder({ gapMs: 40 * MIN }).build(
        [inside, past],
        T0 + 32 * MIN,
        neverRecovers,
        [boundary(T0, head.id)],
      );

      expect(incidents.map((i) => i.entries.map((e) => e.anomalyId))).toEqual([
        [inside.id],
        [past.id],
      ]);
      expect(incidents[0].startedAt).toBe(T0);
      expect(incidents[1].startedAt).toBe(T0 + 31 * MIN);
    });

    it('does not reuse a stored start past the gap for the first event', () => {
      const head = event({ timestamp: T0 });
      const fresh = event({ timestamp: T0 + 10 * MIN });
      const next = event({ timestamp: T0 + 11 * MIN });

      const incidents = new IncidentTimelineBuilder().build(
        [fresh, next],
        T0 + 12 * MIN,
        neverRecovers,
        [boundary(T0, head.id)],
      );

      expect(incidents).toHaveLength(1);
      expect(incidents[0].startedAt).toBe(T0 + 10 * MIN);
      expect(incidents[0].entries.map((e) => e.anomalyId)).toEqual([fresh.id, next.id]);
    });

    it('splits on a boundary whose event is no longer loaded', () => {
      const before = event({ timestamp: T0 });
      const after = event({ timestamp: T0 + 2 * MIN });

      const incidents = new IncidentTimelineBuilder().build(
        [before, after],
        T0 + 3 * MIN,
        neverRecovers,
        [boundary(T0 + MIN, 'evicted')],
      );

      expect(incidents.map((i) => i.startedAt)).toEqual([T0, T0 + MIN]);
    });

    it('keeps a late event inside the incident whose stored start follows it', () => {
      const late = event({ timestamp: T0 - 10_000 });
      const start = event({ timestamp: T0 });
      const stored = boundary(T0, start.id);

      const incidents = new IncidentTimelineBuilder().build(
        [late, start],
        T0 + MIN,
        neverRecovers,
        [stored],
      );

      expect(incidents).toHaveLength(1);
      expect(incidents[0].startedAt).toBe(T0 - 10_000);
      expect(incidents[0].incidentId).toBe(incidentIdFor('conn-a', start.id, T0));
      expect(incidents[0].entries.map((e) => e.anomalyId)).toEqual([late.id, start.id]);
    });

    it('keeps an earlier incident apart when a quiet gap precedes the stored start', () => {
      const earlier = event({ timestamp: T0 - 10 * MIN });
      const start = event({ timestamp: T0 });

      const incidents = new IncidentTimelineBuilder().build(
        [earlier, start],
        T0 + MIN,
        neverRecovers,
        [boundary(T0, start.id)],
      );

      expect(incidents.map((i) => i.startedAt)).toEqual([T0 - 10 * MIN, T0]);
      expect(incidents[1].incidentId).toBe(incidentIdFor('conn-a', start.id, T0));
      expect(incidents[0].incidentId).toBe(incidentIdFor('conn-a', earlier.id, T0 - 10 * MIN));
    });

    it('keeps an incident at the span cap apart from the stored start after it', () => {
      const chain = Array.from({ length: 31 }, (_, i) => event({ timestamp: T0 + i * MIN }));
      const start = event({ timestamp: T0 + 31 * MIN });

      const incidents = new IncidentTimelineBuilder().build(
        [...chain, start],
        T0 + 32 * MIN,
        neverRecovers,
        [boundary(T0 + 31 * MIN, start.id)],
      );

      expect(incidents[incidents.length - 1].entries.map((e) => e.anomalyId)).toEqual([start.id]);
    });

    it('does not reuse a boundary id after a quiet gap', () => {
      const head = event({ timestamp: T0 });
      const tail = event({ timestamp: T0 + 10 * MIN });

      const incidents = new IncidentTimelineBuilder().build(
        [head, tail],
        T0 + 11 * MIN,
        neverRecovers,
        [boundary(T0, head.id)],
      );

      expect(new Set(incidents.map((i) => i.incidentId)).size).toBe(2);
      expect(incidents[1].startedAt).toBe(T0 + 10 * MIN);
    });

    it('ignores a boundary older than the span cap and other scopes', () => {
      const lone = event({ timestamp: T0 });

      const [incident] = new IncidentTimelineBuilder().build([lone], T0 + MIN, neverRecovers, [
        boundary(T0 - 31 * MIN, 'stale'),
        boundary(T0 - MIN, 'foreign', 'conn-b'),
      ]);

      expect(incident.incidentId).toBe(incidentIdFor('conn-a', lone.id, T0));
      expect(incident.startedAt).toBe(T0);
    });
  });

  describe('same timestamp ordering', () => {
    const later = (eventSequence?: number) =>
      event({ id: 'a-later', eventSequence, metricType: MetricType.MEMORY_USED });
    const earlier = (eventSequence?: number) =>
      event({ id: 'z-earlier', eventSequence, metricType: MetricType.CONNECTIONS });

    it('orders events of one timestamp by insertion, not by id', () => {
      const [incident] = new IncidentTimelineBuilder().build(
        [later(2), earlier(1)],
        T0 + MIN,
        neverRecovers,
      );

      expect(incident.entries.map((e) => e.anomalyId)).toEqual(['z-earlier', 'a-later']);
      expect(incident.sequence).toEqual([MetricType.CONNECTIONS, MetricType.MEMORY_USED]);
    });

    it('builds the same incident id from either read order', () => {
      const builder = new IncidentTimelineBuilder();

      const [one] = builder.build([later(2), earlier(1)], T0 + MIN, neverRecovers);
      const [other] = builder.build([earlier(1), later(2)], T0 + MIN, neverRecovers);

      expect(one.incidentId).toBe(other.incidentId);
    });

    it('falls back to the id for rows without a sequence', () => {
      const [incident] = new IncidentTimelineBuilder().build(
        [earlier(), later()],
        T0 + MIN,
        neverRecovers,
      );

      expect(incident.entries.map((e) => e.anomalyId)).toEqual(['a-later', 'z-earlier']);
    });
  });

  describe('clustering', () => {
    it('keeps events within the gap in one incident, ordered by time then id', () => {
      const later = event({ timestamp: T0 + MIN, metricType: MetricType.OPS_PER_SEC });
      const first = event({ timestamp: T0, metricType: MetricType.CONNECTIONS });
      const tie = event({ timestamp: T0 + MIN, metricType: MetricType.CPU_UTILIZATION });

      const [incident, ...rest] = new IncidentTimelineBuilder().build(
        [tie, later, first],
        T0 + 2 * MIN,
        neverRecovers,
      );

      expect(rest).toHaveLength(0);
      expect(incident.entries.map((e) => e.anomalyId)).toEqual([first.id, later.id, tie.id]);
      expect(incident.sequence).toEqual([
        MetricType.CONNECTIONS,
        MetricType.OPS_PER_SEC,
        MetricType.CPU_UTILIZATION,
      ]);
      expect(incident.startedAt).toBe(T0);
      expect(incident.lastEventAt).toBe(T0 + MIN);
    });

    describe('across dropped spans', () => {
      const bridged = (span: { from: number; through: number; scopeId?: string }) =>
        new IncidentTimelineBuilder({ gapMs: 2 * MIN }).build(
          [event({ timestamp: T0 }), event({ timestamp: T0 + 5 * MIN })],
          T0 + 6 * MIN,
          neverRecovers,
          [],
          new Map(),
          Number.NEGATIVE_INFINITY,
          new Map([['conn-a', [span]]]),
        );

      it('keeps one incident across a span of dropped events', () => {
        expect(bridged({ from: T0 + MIN, through: T0 + 4 * MIN })).toHaveLength(1);
      });

      it('keeps one incident across a span another connection dropped in the same scope', () => {
        const incidents = new IncidentTimelineBuilder({ gapMs: 2 * MIN }, () => 'cluster').build(
          [
            event({ timestamp: T0, connectionId: 'conn-b' }),
            event({ timestamp: T0 + 5 * MIN }),
          ],
          T0 + 6 * MIN,
          neverRecovers,
          [],
          new Map(),
          Number.NEGATIVE_INFINITY,
          new Map([['conn-a', [{ from: T0 + MIN, through: T0 + 4 * MIN }]]]),
        );

        expect(incidents).toHaveLength(1);
      });

      it('ignores a span dropped while the connection was in another scope', () => {
        expect(
          bridged({ from: T0 + MIN, through: T0 + 4 * MIN, scopeId: 'other' }),
        ).toHaveLength(2);
      });
    });

    it('opens a new incident after a quiet gap', () => {
      const incidents = new IncidentTimelineBuilder({ gapMs: 2 * MIN }).build(
        [event({ timestamp: T0 }), event({ timestamp: T0 + 3 * MIN })],
        T0 + 4 * MIN,
        neverRecovers,
      );

      expect(incidents).toHaveLength(2);
    });

    it('caps an incident at the max span even without a gap', () => {
      const events = [0, 1, 2, 3, 4].map((i) => event({ timestamp: T0 + i * MIN }));

      const incidents = new IncidentTimelineBuilder({ gapMs: 2 * MIN, maxSpanMs: 3 * MIN }).build(
        events,
        T0 + 5 * MIN,
        neverRecovers,
      );

      expect(incidents.map((i) => i.entries.length)).toEqual([4, 1]);
    });

    it('separates scopes and groups members of one scope', () => {
      const scopeOf = (id: string) => (id === 'node-1' || id === 'node-2' ? 'cluster-x' : id);
      const incidents = new IncidentTimelineBuilder({}, scopeOf).build(
        [
          event({ connectionId: 'node-1' }),
          event({ connectionId: 'node-2', timestamp: T0 + 1000 }),
          event({ connectionId: 'standalone', timestamp: T0 + 2000 }),
        ],
        T0 + MIN,
        neverRecovers,
      );

      expect(incidents).toHaveLength(2);
      const cluster = incidents.find((i) => i.scope === 'cluster-x')!;
      expect(cluster.connectionIds).toEqual(['node-1', 'node-2']);
    });

    it('leaves events without a connection out of the connection list', () => {
      const [incident] = new IncidentTimelineBuilder().build(
        [
          event({ connectionId: '', scopeId: 'cluster-x' }),
          event({
            connectionId: 'node-1',
            scopeId: 'cluster-x',
            metricType: MetricType.CONNECTIONS,
            timestamp: T0 + 1000,
          }),
        ],
        T0 + MIN,
        neverRecovers,
      );

      expect(incident.connectionIds).toEqual(['node-1']);
    });

    it('derives a stable incident id from the scope and first anomaly', () => {
      const first = event();
      const build = () =>
        new IncidentTimelineBuilder().build(
          [first, event({ timestamp: T0 + 1 })],
          T0,
          neverRecovers,
        );

      expect(build()[0].incidentId).toBe(incidentIdFor('conn-a', first.id, T0));
      expect(build()[0].incidentId).toBe(build()[0].incidentId);
    });

    it('carries the start time in the incident id', () => {
      const [incident] = new IncidentTimelineBuilder().build(
        [event({ timestamp: T0 + 5000 })],
        T0 + MIN,
        neverRecovers,
      );

      expect(incidentStartOf(incident.incidentId)).toBe(T0 + 5000);
      expect(incidentStartOf('not-an-id')).toBeNull();
    });
  });

  describe('recovery', () => {
    it('is active while events keep arriving', () => {
      const [incident] = new IncidentTimelineBuilder().build(
        [event()],
        T0 + 30_000,
        recoversAfterQuiet,
      );

      expect(incident.recovery.status).toBe('active');
      expect(incident.recovery.openSignals).toEqual([MetricType.MEMORY_USED]);
    });

    it('is recovered once every signal recovered and the incident went quiet', () => {
      const [incident] = new IncidentTimelineBuilder().build(
        [
          event({ metricType: MetricType.CONNECTIONS }),
          event({ metricType: MetricType.MEMORY_USED, timestamp: T0 + MIN }),
        ],
        T0 + 5 * MIN,
        recoversAfterQuiet,
      );

      expect(incident.recovery).toEqual({
        status: 'recovered',
        openSignals: [],
        unknownSignals: [],
        recoveredAt: T0 + 2 * MIN,
      });
      expect(incident.entries.map((e) => e.recoveredAt)).toEqual([T0 + MIN, T0 + 2 * MIN]);
    });

    it('uses resolvedAt for a self-resolving event', () => {
      const [incident] = new IncidentTimelineBuilder().build(
        [event({ resolved: true, resolvedAt: T0 + 90_000 })],
        T0 + 5 * MIN,
        neverRecovers,
      );

      expect(incident.recovery.status).toBe('recovered');
      expect(incident.recovery.recoveredAt).toBe(T0 + 90_000);
    });

    it('treats a resolved row without resolvedAt as recovered at an unknown time', () => {
      const [incident] = new IncidentTimelineBuilder().build(
        [
          event({ resolved: true }),
          event({ timestamp: T0 + MIN, resolved: true }),
          event({
            metricType: MetricType.CONNECTIONS,
            timestamp: T0 + 2 * MIN,
            resolved: true,
            resolvedAt: T0 + 3 * MIN,
          }),
        ],
        T0 + 5 * MIN,
        neverRecovers,
      );

      expect(incident.recovery).toEqual({
        status: 'recovered',
        openSignals: [],
        unknownSignals: [],
        recoveredAt: null,
      });
      expect(incident.entries.map((e) => e.recoveredAt)).toEqual([null, null, T0 + 3 * MIN]);
      expect(incident.entries.map((e) => e.recoveryState)).toEqual([
        'recovered',
        'recovered',
        'recovered',
      ]);
    });

    it('does not ask the probe before the settle time', () => {
      const probe = jest.fn().mockReturnValue(T0);

      new IncidentTimelineBuilder({ settleMs: MIN }).build([event()], T0 + 30_000, probe);

      expect(probe).not.toHaveBeenCalled();
    });

    it('is recovering while quiet with signals still open', () => {
      const [incident] = new IncidentTimelineBuilder().build(
        [
          event({ metricType: MetricType.CONNECTIONS }),
          event({ metricType: MetricType.CPU_UTILIZATION }),
        ],
        T0 + 5 * MIN,
        ({ metricType, since }) => (metricType === MetricType.CONNECTIONS ? since + MIN : null),
      );

      expect(incident.recovery.status).toBe('recovering');
      expect(incident.recovery.openSignals).toEqual([MetricType.CPU_UTILIZATION]);
      expect(incident.recovery.recoveredAt).toBeNull();
    });

    it('reports recovery as unknown when the probe cannot tell', () => {
      const [incident] = new IncidentTimelineBuilder().build(
        [
          event({ metricType: MetricType.CONNECTIONS }),
          event({ metricType: MetricType.MEMORY_USED, timestamp: T0 + MIN }),
        ],
        T0 + 30 * MIN,
        ({ metricType, since }) =>
          metricType === MetricType.CONNECTIONS ? since + MIN : undefined,
      );

      expect(incident.recovery).toEqual({
        status: 'unknown',
        openSignals: [],
        unknownSignals: [MetricType.MEMORY_USED],
        recoveredAt: null,
      });
      expect(incident.entries.map((e) => e.recoveredAt)).toEqual([T0 + MIN, null]);
      expect(incident.entries.map((e) => e.recoveryState)).toEqual(['recovered', 'unknown']);
    });

    it('keeps an incident with an open signal recovering even if another is unknown', () => {
      const [incident] = new IncidentTimelineBuilder().build(
        [
          event({ metricType: MetricType.CONNECTIONS }),
          event({ metricType: MetricType.MEMORY_USED }),
        ],
        T0 + 5 * MIN,
        ({ metricType }) => (metricType === MetricType.CONNECTIONS ? null : undefined),
      );

      expect(incident.recovery.status).toBe('recovering');
      expect(incident.recovery.openSignals).toEqual([MetricType.CONNECTIONS]);
      expect(incident.recovery.unknownSignals).toEqual([MetricType.MEMORY_USED]);
      expect(incident.entries.map((e) => e.recoveryState)).toEqual(['open', 'unknown']);
    });

    it('settles into degraded when signals stay open past the degraded threshold', () => {
      const [incident] = new IncidentTimelineBuilder().build(
        [event()],
        T0 + 11 * MIN,
        neverRecovers,
      );

      expect(incident.recovery.status).toBe('degraded');
    });

    it('judges a signal by its latest event only', () => {
      const probe = jest.fn<ReturnType<RecoveryProbe>, Parameters<RecoveryProbe>>(
        ({ since }) => since + MIN,
      );

      new IncidentTimelineBuilder().build(
        [event(), event({ timestamp: T0 + MIN })],
        T0 + 5 * MIN,
        probe,
      );

      expect(probe).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: 'conn-a',
          metricType: MetricType.MEMORY_USED,
          since: T0 + MIN,
          until: null,
        }),
      );
    });

    it('judges recovery against the baseline from before the incident', () => {
      const probe = jest.fn<ReturnType<RecoveryProbe>, Parameters<RecoveryProbe>>(() => null);

      new IncidentTimelineBuilder().build(
        [
          event({ baseline: 100, stdDev: 5 }),
          event({ timestamp: T0 + MIN, baseline: 400, stdDev: 50 }),
        ],
        T0 + 5 * MIN,
        probe,
      );

      expect(probe).toHaveBeenCalledWith(expect.objectContaining({ baseline: 100, stdDev: 5 }));
    });

    it('bounds the probe by the next occurrence of the signal', () => {
      const probe = jest.fn<ReturnType<RecoveryProbe>, Parameters<RecoveryProbe>>(() => null);

      new IncidentTimelineBuilder({ gapMs: 2 * MIN }).build(
        [event(), event({ timestamp: T0 + 10 * MIN })],
        T0 + 20 * MIN,
        probe,
      );

      expect(probe).toHaveBeenCalledWith(
        expect.objectContaining({ since: T0, until: T0 + 10 * MIN }),
      );
      expect(probe).toHaveBeenCalledWith(
        expect.objectContaining({ since: T0 + 10 * MIN, until: null }),
      );
    });
  });

  describe('sequence rules across a quiet gap', () => {
    const build = (events: AnomalyEvent[], rule = escalation, boundaries: any[] = []) =>
      new IncidentTimelineBuilder({}, (id) => id, () => [rule]).build(
        events,
        T0 + 20 * MIN,
        neverRecovers,
        boundaries,
      );

    it('keeps a later step of a rule in the incident that holds the earlier one', () => {
      const incidents = build([
        event({ metricType: MetricType.CONNECTIONS }),
        event({ timestamp: T0 + 5 * MIN }),
      ]);

      expect(incidents).toHaveLength(1);
      expect(incidents[0].matchedPatterns).toEqual([escalation.pattern]);
    });

    it('still splits an event no rule links to the incident', () => {
      const incidents = build([
        event({ metricType: MetricType.MEMORY_USED }),
        event({ timestamp: T0 + 5 * MIN, metricType: MetricType.CONNECTIONS }),
      ]);

      expect(incidents).toHaveLength(2);
    });

    it('splits past the span of the rule', () => {
      const incidents = build([
        event({ metricType: MetricType.CONNECTIONS }),
        event({ timestamp: T0 + 11 * MIN }),
      ]);

      expect(incidents).toHaveLength(2);
    });

    it('splits a same-connection rule across different connections', () => {
      const scopes = new IncidentTimelineBuilder({}, () => 'shared', () => [
        { ...escalation, sameConnection: true },
      ]);

      const incidents = scopes.build(
        [
          event({ metricType: MetricType.CONNECTIONS, connectionId: 'conn-a' }),
          event({ timestamp: T0 + 5 * MIN, connectionId: 'conn-b' }),
        ],
        T0 + 20 * MIN,
        neverRecovers,
      );

      expect(incidents).toHaveLength(2);
    });

    it('splits a same-connection rule across nodes of one connection', () => {
      const scopes = new IncidentTimelineBuilder({}, () => 'shared', () => [
        { ...escalation, sameConnection: true },
      ]);

      const incidents = scopes.build(
        [
          event({ metricType: MetricType.CONNECTIONS, nodeAddr: '10.0.0.5:6379' }),
          event({ timestamp: T0 + 5 * MIN, nodeAddr: '10.0.0.7:6379' }),
        ],
        T0 + 20 * MIN,
        neverRecovers,
      );

      expect(incidents).toHaveLength(2);
    });

    it('keeps a same-connection rule together on one node', () => {
      const scopes = new IncidentTimelineBuilder({}, () => 'shared', () => [
        { ...escalation, sameConnection: true },
      ]);

      const incidents = scopes.build(
        [
          event({ metricType: MetricType.CONNECTIONS, nodeAddr: '10.0.0.5:6379' }),
          event({ timestamp: T0 + 5 * MIN, nodeAddr: '10.0.0.5:6379' }),
        ],
        T0 + 20 * MIN,
        neverRecovers,
      );

      expect(incidents).toHaveLength(1);
    });

    describe('when the earlier step is no longer held', () => {
      const anchor = {
        scopeId: 'conn-a',
        startedAt: T0,
        anomalyId: 'z-gone',
        metricType: MetricType.CONNECTIONS,
        connectionId: 'conn-a',
      };
      const dropped = (
        late: AnomalyEvent,
        stored: Partial<typeof anchor> = {},
        rule: SequenceRule = escalation,
      ) =>
        new IncidentTimelineBuilder({}, () => 'conn-a', () => [rule]).build(
          [late],
          T0 + 20 * MIN,
          neverRecovers,
          [{ ...anchor, ...stored }],
          new Map([['conn-a', T0]]),
        );

      it('keeps the stored start for a later step the rule can still bridge', () => {
        const [incident] = dropped(event({ id: 'late', timestamp: T0 + 5 * MIN }));

        expect(incidentStartOf(incident.incidentId)).toBe(T0);
      });

      it('starts afresh for an event that is not a later step of a rule', () => {
        const [incident] = dropped(
          event({ id: 'late', timestamp: T0 + 5 * MIN, metricType: MetricType.CONNECTIONS }),
        );

        expect(incidentStartOf(incident.incidentId)).toBe(T0 + 5 * MIN);
      });

      it('measures the span of the rule from the stored start', () => {
        const [incident] = new IncidentTimelineBuilder({}, (id) => id, () => [escalation]).build(
          [event({ id: 'late', timestamp: T0 + 15 * MIN })],
          T0 + 20 * MIN,
          neverRecovers,
          [anchor],
          new Map([['conn-a', T0 + 9 * MIN]]),
        );

        expect(incidentStartOf(incident.incidentId)).toBe(T0 + 15 * MIN);
      });

      it('starts afresh past the span of the rule', () => {
        const [incident] = dropped(event({ id: 'late', timestamp: T0 + 11 * MIN }));

        expect(incidentStartOf(incident.incidentId)).toBe(T0 + 11 * MIN);
      });

      it('starts afresh when the stored start was not the step before', () => {
        const [incident] = dropped(event({ id: 'late', timestamp: T0 + 5 * MIN }), {
          metricType: MetricType.MEMORY_USED,
        });

        expect(incidentStartOf(incident.incidentId)).toBe(T0 + 5 * MIN);
      });

      it('starts afresh when a same-connection rule began on another connection', () => {
        const [incident] = dropped(
          event({ id: 'late', timestamp: T0 + 5 * MIN }),
          { connectionId: 'conn-b' },
          { ...escalation, sameConnection: true },
        );

        expect(incidentStartOf(incident.incidentId)).toBe(T0 + 5 * MIN);
      });

      it('keeps the stored start when a same-connection rule began on the same connection', () => {
        const [incident] = dropped(
          event({ id: 'late', timestamp: T0 + 5 * MIN }),
          {},
          { ...escalation, sameConnection: true },
        );

        expect(incidentStartOf(incident.incidentId)).toBe(T0);
      });

      describe('when a later member of the incident was the step before', () => {
        const unrelatedStart = { ...anchor, metricType: MetricType.MEMORY_USED };
        const step = { metricType: MetricType.CONNECTIONS, connectionId: 'conn-a', timestamp: T0 + MIN };
        const withMember = (droppedThrough: number) =>
          new IncidentTimelineBuilder({}, () => 'conn-a', () => [escalation]).build(
            [event({ id: 'late', timestamp: T0 + 8 * MIN })],
            T0 + 20 * MIN,
            neverRecovers,
            [{ ...unrelatedStart, members: [step] }],
            new Map([['conn-a', droppedThrough]]),
          );

        it('keeps the stored start', () => {
          const [incident] = withMember(T0 + MIN);

          expect(incidentStartOf(incident.incidentId)).toBe(T0);
        });

        it('does not bridge from a member that was not dropped', () => {
          const [incident] = withMember(T0 + MIN - 1);

          expect(incidentStartOf(incident.incidentId)).toBe(T0 + 8 * MIN);
        });
      });

      it('starts afresh when the stored start does not say what began it', () => {
        const [incident] = dropped(event({ id: 'late', timestamp: T0 + 5 * MIN }), {
          metricType: undefined,
          connectionId: undefined,
        });

        expect(incidentStartOf(incident.incidentId)).toBe(T0 + 5 * MIN);
      });
    });

    describe('with a rule of three steps', () => {
      const chain: SequenceRule = {
        ...escalation,
        steps: [[MetricType.CONNECTIONS], [MetricType.OPS_PER_SEC], [MetricType.MEMORY_USED]],
      };

      it('does not take in the last step when only the step before it was seen', () => {
        const incidents = build(
          [
            event({ metricType: MetricType.OPS_PER_SEC }),
            event({ timestamp: T0 + 5 * MIN }),
          ],
          chain,
        );

        expect(incidents).toHaveLength(2);
      });

      it('takes in the last step once every earlier step was seen in order', () => {
        const incidents = build(
          [
            event({ metricType: MetricType.CONNECTIONS }),
            event({ timestamp: T0 + MIN, metricType: MetricType.OPS_PER_SEC }),
            event({ timestamp: T0 + 6 * MIN }),
          ],
          chain,
        );

        expect(incidents).toHaveLength(1);
        expect(incidents[0].matchedPatterns).toEqual([chain.pattern]);
      });

      it('does not take in the last step when the earlier steps came out of order', () => {
        const incidents = build(
          [
            event({ metricType: MetricType.OPS_PER_SEC }),
            event({ timestamp: T0 + MIN, metricType: MetricType.CONNECTIONS }),
            event({ timestamp: T0 + 6 * MIN }),
          ],
          chain,
        );

        expect(incidents).toHaveLength(2);
      });

      it('does not bridge a dropped start on the last step when only the step before it was dropped', () => {
        const [incident] = new IncidentTimelineBuilder({}, () => 'conn-a', () => [chain]).build(
          [event({ id: 'late', timestamp: T0 + 5 * MIN })],
          T0 + 20 * MIN,
          neverRecovers,
          [
            {
              scopeId: 'conn-a',
              startedAt: T0,
              anomalyId: 'z-gone',
              metricType: MetricType.OPS_PER_SEC,
              connectionId: 'conn-a',
            },
          ],
          new Map([['conn-a', T0]]),
        );

        expect(incidentStartOf(incident.incidentId)).toBe(T0 + 5 * MIN);
      });

      it('takes in the last step after a retained step once the first step was dropped', () => {
        const incidents = new IncidentTimelineBuilder({}, () => 'conn-a', () => [chain]).build(
          [
            event({ id: 'middle', timestamp: T0 + 4 * MIN, metricType: MetricType.OPS_PER_SEC }),
            event({ id: 'late', timestamp: T0 + 8 * MIN }),
          ],
          T0 + 20 * MIN,
          neverRecovers,
          [
            {
              scopeId: 'conn-a',
              startedAt: T0,
              anomalyId: 'z-gone',
              metricType: MetricType.CONNECTIONS,
              connectionId: 'conn-a',
            },
          ],
          new Map([['conn-a', T0]]),
        );

        expect(incidents).toHaveLength(1);
        expect(incidentStartOf(incidents[0].incidentId)).toBe(T0);
        expect(incidents[0].matchedPatterns).toEqual([chain.pattern]);
        expect(incidents[0].sequenceMatches[0].anomalyIds).toEqual(['middle', 'late']);
      });

      it('bridges a dropped start on the last step when every earlier step was dropped', () => {
        const [incident] = new IncidentTimelineBuilder({}, () => 'conn-a', () => [chain]).build(
          [event({ id: 'late', timestamp: T0 + 5 * MIN })],
          T0 + 20 * MIN,
          neverRecovers,
          [
            {
              scopeId: 'conn-a',
              startedAt: T0,
              anomalyId: 'z-gone',
              metricType: MetricType.CONNECTIONS,
              connectionId: 'conn-a',
              members: [{ metricType: MetricType.OPS_PER_SEC, connectionId: 'conn-a', timestamp: T0 + MIN }],
            },
          ],
          new Map([['conn-a', T0 + MIN]]),
        );

        expect(incidentStartOf(incident.incidentId)).toBe(T0);
      });
    });

    it('matches a retained later step when an earlier copy of it was dropped too', () => {
      const [incident] = new IncidentTimelineBuilder({}, () => 'conn-a', () => [escalation]).build(
        [event({ id: 'held', timestamp: T0 + 4 * MIN })],
        T0 + 20 * MIN,
        neverRecovers,
        [
          {
            scopeId: 'conn-a',
            startedAt: T0,
            anomalyId: 'z-gone',
            metricType: MetricType.CONNECTIONS,
            connectionId: 'conn-a',
            members: [{ metricType: MetricType.MEMORY_USED, connectionId: 'conn-a', timestamp: T0 + MIN }],
          },
        ],
        new Map([['conn-a', T0 + MIN]]),
      );

      expect(incidentStartOf(incident.incidentId)).toBe(T0);
      expect(incident.matchedPatterns).toEqual([escalation.pattern]);
      expect(incident.sequenceMatches[0].anomalyIds).toEqual(['held']);
      expect(incident.sequenceMatches[0].steps).toEqual([2]);
    });

    describe('with a step that may come before the step it follows', () => {
      const leading: SequenceRule = {
        ...escalation,
        steps: [[MetricType.CONNECTIONS], [MetricType.OPS_PER_SEC], [MetricType.MEMORY_USED]],
        leadMs: { 2: 6 * MIN },
      };

      it('keeps the first step in the incident of a lead step it follows within the lead', () => {
        const incidents = build(
          [
            event({ metricType: MetricType.MEMORY_USED }),
            event({ timestamp: T0 + 5 * MIN, metricType: MetricType.CONNECTIONS }),
            event({ timestamp: T0 + 6 * MIN, metricType: MetricType.OPS_PER_SEC }),
          ],
          leading,
        );

        expect(incidents).toHaveLength(1);
        expect(incidents[0].matchedPatterns).toEqual([leading.pattern]);
      });

      it('keeps a lead step that arrives after a quiet gap, before the step it follows', () => {
        const incidents = build(
          [
            event({ metricType: MetricType.CONNECTIONS }),
            event({ timestamp: T0 + 3 * MIN, metricType: MetricType.MEMORY_USED }),
            event({ timestamp: T0 + 6 * MIN, metricType: MetricType.OPS_PER_SEC }),
          ],
          leading,
        );

        expect(incidents).toHaveLength(1);
        expect(incidents[0].matchedPatterns).toEqual([leading.pattern]);
      });

      it('splits the first step from a lead step further back than the lead', () => {
        const incidents = build(
          [
            event({ metricType: MetricType.MEMORY_USED }),
            event({ timestamp: T0 + 7 * MIN, metricType: MetricType.CONNECTIONS }),
          ],
          leading,
        );

        expect(incidents).toHaveLength(2);
      });

      it('takes in a later step once every earlier step was seen, the lead step out of order', () => {
        const chain: SequenceRule = {
          ...escalation,
          steps: [[MetricType.CONNECTIONS], [MetricType.MEMORY_USED], [MetricType.OPS_PER_SEC], [MetricType.FRAGMENTATION_RATIO]],
          leadMs: { 2: 6 * MIN },
        };

        const incidents = build(
          [
            event({ metricType: MetricType.CONNECTIONS }),
            event({ timestamp: T0 + MIN, metricType: MetricType.OPS_PER_SEC }),
            event({ timestamp: T0 + 2 * MIN, metricType: MetricType.MEMORY_USED }),
            event({ timestamp: T0 + 7 * MIN, metricType: MetricType.FRAGMENTATION_RATIO }),
          ],
          chain,
        );

        expect(incidents).toHaveLength(1);
        expect(incidents[0].matchedPatterns).toEqual([chain.pattern]);
      });
    });

    it('takes in a step stamped ahead of an incident that already has a boundary', () => {
      const cost = event({ timestamp: T0 + 5 * MIN });
      const started = { scopeId: 'conn-a', startedAt: cost.timestamp, anomalyId: cost.id };

      const incidents = build(
        [event({ metricType: MetricType.CONNECTIONS }), cost],
        escalation,
        [started],
      );

      expect(incidents).toHaveLength(1);
      expect(incidents[0].matchedPatterns).toEqual([escalation.pattern]);
    });
  });

  describe('sequence rules', () => {
    const builder = () => new IncidentTimelineBuilder({}, undefined, () => [escalation]);

    it('matches steps in order', () => {
      const conn = event({ metricType: MetricType.CONNECTIONS, severity: AnomalySeverity.WARNING });
      const mem = event({
        metricType: MetricType.FRAGMENTATION_RATIO,
        timestamp: T0 + MIN,
        severity: AnomalySeverity.CRITICAL,
      });

      const [incident] = builder().build([conn, mem], T0 + 2 * MIN, neverRecovers);

      expect(incident.matchedPatterns).toEqual([AnomalyPattern.MEMORY_PRESSURE]);
      expect(incident.sequenceMatches[0]).toEqual(
        expect.objectContaining({
          anomalyIds: [conn.id, mem.id],
          steps: [1, 2],
          severity: AnomalySeverity.CRITICAL,
          diagnosis: escalation.diagnosis,
        }),
      );
    });

    it('numbers an optional event as no step', () => {
      const conn = event({ metricType: MetricType.CONNECTIONS });
      const evicted = event({ metricType: MetricType.EVICTED_KEYS, timestamp: T0 + MIN });
      const mem = event({ metricType: MetricType.MEMORY_USED, timestamp: T0 + 2 * MIN });

      const [incident] = new IncidentTimelineBuilder({}, undefined, () => [
        { ...escalation, optionalMetrics: [MetricType.EVICTED_KEYS] },
      ]).build([conn, evicted, mem], T0 + 3 * MIN, neverRecovers);

      expect(incident.sequenceMatches[0].anomalyIds).toEqual([conn.id, mem.id, evicted.id]);
      expect(incident.sequenceMatches[0].steps).toEqual([1, 2, null]);
    });

    it('does not match the steps in reverse order', () => {
      const [incident] = builder().build(
        [
          event({ metricType: MetricType.MEMORY_USED }),
          event({ metricType: MetricType.CONNECTIONS, timestamp: T0 + MIN }),
        ],
        T0 + 2 * MIN,
        neverRecovers,
      );

      expect(incident.matchedPatterns).toEqual([]);
    });

    it('does not match when the steps span more than the rule allows', () => {
      const [incident] = new IncidentTimelineBuilder({}, undefined, () => [
        { ...escalation, maxSpanMs: MIN },
      ]).build(
        [
          event({ metricType: MetricType.CONNECTIONS }),
          event({ metricType: MetricType.OPS_PER_SEC, timestamp: T0 + MIN }),
          event({ metricType: MetricType.MEMORY_USED, timestamp: T0 + 2 * MIN }),
        ],
        T0 + 3 * MIN,
        neverRecovers,
      );

      expect(incident.matchedPatterns).toEqual([]);
    });

    it('retries from a later first step when an early one runs out of span', () => {
      const late = event({ metricType: MetricType.CONNECTIONS, timestamp: T0 + 2 * MIN });
      const [incident] = new IncidentTimelineBuilder({}, undefined, () => [
        { ...escalation, maxSpanMs: MIN },
      ]).build(
        [
          event({ metricType: MetricType.CONNECTIONS }),
          late,
          event({ metricType: MetricType.MEMORY_USED, timestamp: T0 + 2 * MIN + 1000 }),
        ],
        T0 + 3 * MIN,
        neverRecovers,
      );

      expect(incident.sequenceMatches[0].anomalyIds[0]).toBe(late.id);
    });

    describe('with a step that may come before the step it follows', () => {
      const leading: SequenceRule = {
        ...escalation,
        steps: [[MetricType.CONNECTIONS], [MetricType.OPS_PER_SEC], [MetricType.MEMORY_USED]],
        leadMs: { 2: 3 * MIN },
      };
      const entry = (metricType: MetricType, at: number) =>
        toTimelineEntry(event({ metricType, timestamp: T0 + at * MIN }));

      it('matches the lead step after the step it follows', () => {
        const entries = [
          entry(MetricType.CONNECTIONS, 0),
          entry(MetricType.OPS_PER_SEC, 1),
          entry(MetricType.MEMORY_USED, 2),
        ];

        expect(matchSequence(entries, leading)).toEqual(entries);
      });

      it('matches the lead step before the step it follows, within the lead', () => {
        const entries = [
          entry(MetricType.CONNECTIONS, 0),
          entry(MetricType.MEMORY_USED, 1),
          entry(MetricType.OPS_PER_SEC, 4),
        ];

        expect(matchSequence(entries, leading)).toEqual([entries[0], entries[2], entries[1]]);
      });

      it('matches the lead step before the first step, within the lead and the span', () => {
        const entries = [
          entry(MetricType.MEMORY_USED, 0),
          entry(MetricType.CONNECTIONS, 1),
          entry(MetricType.OPS_PER_SEC, 2),
        ];

        expect(matchSequence(entries, leading)).toEqual([entries[1], entries[2], entries[0]]);
      });

      it('does not match the lead step further back than the lead', () => {
        const entries = [
          entry(MetricType.CONNECTIONS, 0),
          entry(MetricType.MEMORY_USED, 1),
          entry(MetricType.OPS_PER_SEC, 5),
        ];

        expect(matchSequence(entries, leading)).toBeNull();
      });

      it('measures the span from the earliest to the latest matched step', () => {
        const entries = [
          entry(MetricType.MEMORY_USED, 0),
          entry(MetricType.CONNECTIONS, 2),
          entry(MetricType.OPS_PER_SEC, 3),
        ];

        expect(matchSequence(entries, { ...leading, maxSpanMs: 2 * MIN })).toBeNull();
      });

      it('tries a later lead step when an earlier one leaves no room for the next step', () => {
        const middle: SequenceRule = { ...leading, maxSpanMs: 2 * MIN, leadMs: { 1: 3 * MIN } };
        const entries = [
          entry(MetricType.OPS_PER_SEC, 0),
          entry(MetricType.CONNECTIONS, 1),
          entry(MetricType.OPS_PER_SEC, 2),
          entry(MetricType.MEMORY_USED, 3),
        ];

        expect(matchSequence(entries, middle)).toEqual([entries[1], entries[2], entries[3]]);
      });

      it('reaches the step after a lead step seen before its own previous step', () => {
        const chain: SequenceRule = {
          ...leading,
          steps: [...leading.steps, [MetricType.FRAGMENTATION_RATIO]],
        };
        const earlier = [
          { metricType: MetricType.CONNECTIONS, connectionId: 'conn-a', timestamp: T0 },
          { metricType: MetricType.MEMORY_USED, connectionId: 'conn-a', timestamp: T0 + MIN },
          { metricType: MetricType.OPS_PER_SEC, connectionId: 'conn-a', timestamp: T0 + 2 * MIN },
        ];
        const next = {
          metricType: MetricType.FRAGMENTATION_RATIO,
          connectionId: 'conn-a',
          timestamp: T0 + 5 * MIN,
        };

        expect(reachesStep(earlier, next, chain, 3)).toBe(true);
        expect(reachesStep(earlier.slice(0, 2), next, chain, 3)).toBe(false);
      });
    });

    it('lists a recommendation once when two matches of one incident share it', () => {
      const other: SequenceRule = {
        ...escalation,
        pattern: AnomalyPattern.CONNECTION_LEAK,
        recommendations: ['Check clients', 'Close idle connections'],
      };

      const [incident] = new IncidentTimelineBuilder({}, undefined, () => [escalation, other]).build(
        [event({ metricType: MetricType.CONNECTIONS }), event({ timestamp: T0 + MIN })],
        T0 + 2 * MIN,
        neverRecovers,
      );

      expect(incident.sequenceMatches.map((m) => m.recommendations)).toEqual([
        ['Check clients'],
        ['Close idle connections'],
      ]);
    });

    it('keeps the recommendations on every match of the same rule', () => {
      const [incident] = builder().build(
        [
          event({ metricType: MetricType.CONNECTIONS }),
          event({ timestamp: T0 + MIN }),
          event({ metricType: MetricType.CONNECTIONS, timestamp: T0 + 2 * MIN }),
          event({ timestamp: T0 + 3 * MIN }),
        ],
        T0 + 4 * MIN,
        neverRecovers,
      );

      expect(incident.sequenceMatches.map((m) => m.recommendations)).toEqual([
        escalation.recommendations,
        escalation.recommendations,
      ]);
    });

    it('matches steps that land in the same poll in either order', () => {
      const mem = event({ metricType: MetricType.MEMORY_USED, id: 'evt-a' });
      const conn = event({ metricType: MetricType.CONNECTIONS, id: 'evt-b' });

      const [incident] = builder().build([mem, conn], T0 + MIN, neverRecovers);

      expect(incident.sequenceMatches[0].anomalyIds).toEqual([conn.id, mem.id]);
    });
  });

  describe('mergeRuleSteps', () => {
    const step = (metricType: MetricType, at: number) => ({
      metricType,
      connectionId: 'conn-a',
      timestamp: T0 + at * MIN,
    });

    it('keeps an earlier step when the same metric repeats later', () => {
      const merged = mergeRuleSteps(
        [step(MetricType.CONNECTIONS, 1), step(MetricType.OPS_PER_SEC, 2)],
        [step(MetricType.CONNECTIONS, 3), step(MetricType.OPS_PER_SEC, 2)],
      );

      expect(merged).toEqual([
        step(MetricType.CONNECTIONS, 1),
        step(MetricType.OPS_PER_SEC, 2),
        step(MetricType.CONNECTIONS, 3),
      ]);
    });
  });
});
