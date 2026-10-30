import { IncidentTimelineBuilder, RecoveryProbe, incidentIdFor } from '../incident-timeline';
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
const recoversAfterQuiet: RecoveryProbe = (_c, _m, since) => since + MIN;

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

      expect(build()[0].incidentId).toBe(incidentIdFor('conn-a', first.id));
      expect(build()[0].incidentId).toBe(build()[0].incidentId);
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
        (_c, metric, since) => (metric === MetricType.CONNECTIONS ? since + MIN : null),
      );

      expect(incident.recovery.status).toBe('recovering');
      expect(incident.recovery.openSignals).toEqual([MetricType.CPU_UTILIZATION]);
      expect(incident.recovery.recoveredAt).toBeNull();
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
      const probe = jest.fn((_c: string, _m: MetricType, since: number) => since + MIN);

      new IncidentTimelineBuilder().build(
        [event(), event({ timestamp: T0 + MIN })],
        T0 + 5 * MIN,
        probe,
      );

      expect(probe).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledWith('conn-a', MetricType.MEMORY_USED, T0 + MIN);
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
  });
});
