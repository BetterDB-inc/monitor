import {
  IncidentTimelineBuilder,
  RecoveryProbe,
  incidentIdFor,
  incidentStartOf,
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
      const inside = event({ timestamp: T0 + 29 * MIN });
      const past = event({ timestamp: T0 + 31 * MIN });

      const incidents = new IncidentTimelineBuilder().build(
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
          severity: AnomalySeverity.CRITICAL,
          diagnosis: escalation.diagnosis,
        }),
      );
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

    it('matches steps that land in the same poll in either order', () => {
      const mem = event({ metricType: MetricType.MEMORY_USED, id: 'evt-a' });
      const conn = event({ metricType: MetricType.CONNECTIONS, id: 'evt-b' });

      const [incident] = builder().build([mem, conn], T0 + MIN, neverRecovers);

      expect(incident.sequenceMatches[0].anomalyIds).toEqual([conn.id, mem.id]);
    });
  });
});
