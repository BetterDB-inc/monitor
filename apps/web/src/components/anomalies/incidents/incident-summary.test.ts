import { describe, expect, it } from 'vitest';
import { entry, incident, T0 } from './incident-fixtures';
import {
  dateRangeQuery,
  findIncidentForAnomalies,
  incidentDurationMs,
  incidentPath,
  incidentsByAnomaly,
  incidentTitle,
  isDurationOngoing,
  orderedEntries,
} from './incident-summary';

describe('incident summary helpers', () => {
  it('measures a recovered incident up to its recovery', () => {
    expect(incidentDurationMs(incident(), T0 + 999_999)).toBe(120_000);
  });

  it('measures an open incident up to now', () => {
    const open = incident({
      recovery: {
        status: 'degraded',
        openSignals: ['connections'],
        unknownSignals: [],
        recoveredAt: null,
      },
    });
    expect(incidentDurationMs(open, T0 + 300_000)).toBe(300_000);
  });

  it('measures an incident with unknown recovery up to its last event', () => {
    const unknown = incident({
      recovery: {
        status: 'unknown',
        openSignals: [],
        unknownSignals: ['connections'],
        recoveredAt: null,
      },
    });
    expect(incidentDurationMs(unknown, T0 + 300_000)).toBe(60_000);
  });

  it('keeps the server order for events with equal timestamps', () => {
    const ordered = orderedEntries(
      incident({
        entries: [
          entry({ anomalyId: 'late', timestamp: T0 + 5 }),
          entry({ anomalyId: 'second', timestamp: T0 }),
          entry({ anomalyId: 'third', timestamp: T0 }),
        ],
      }),
    );
    expect(ordered.map((e) => e.anomalyId)).toEqual(['second', 'third', 'late']);
  });

  it('finds the incident holding any of a group anomalies', () => {
    const target = incident({ incidentId: 'b', entries: [entry({ anomalyId: 'x' })] });
    expect(findIncidentForAnomalies(incidentsByAnomaly([incident(), target]), ['y', 'x'])).toBe(
      target,
    );
    expect(findIncidentForAnomalies(incidentsByAnomaly([incident()]), ['z'])).toBeUndefined();
    expect(findIncidentForAnomalies(incidentsByAnomaly(null), ['x'])).toBeUndefined();
  });

  it('links a group spanning incidents to the one holding most of it, then the newest', () => {
    const older = incident({
      incidentId: 'older',
      startedAt: T0,
      entries: [entry({ anomalyId: 'a' })],
    });
    const newer = incident({
      incidentId: 'newer',
      startedAt: T0 + 600_000,
      entries: [entry({ anomalyId: 'b' }), entry({ anomalyId: 'c' })],
    });
    const byAnomaly = incidentsByAnomaly([older, newer]);

    expect(findIncidentForAnomalies(byAnomaly, ['a', 'b', 'c'])).toBe(newer);
    expect(findIncidentForAnomalies(byAnomaly, ['a', 'b'])).toBe(newer);
    expect(findIncidentForAnomalies(byAnomaly, ['a'])).toBe(older);
  });

  it('encodes the incident id in its path and keeps the date range', () => {
    expect(incidentPath('1-a/b')).toBe('/anomalies/incidents/1-a%2Fb');
    expect(incidentPath('1-a', dateRangeQuery(100, 200))).toBe(
      '/anomalies/incidents/1-a?start=100&end=200',
    );
    expect(dateRangeQuery(100, undefined)).toBe('');
  });

  it('only counts an incident as ongoing while its duration runs to now', () => {
    const active = (recoveredAt: number | null) =>
      incident({
        recovery: { status: 'active', openSignals: [], unknownSignals: [], recoveredAt },
      });
    expect(isDurationOngoing(active(null))).toBe(true);
    expect(isDurationOngoing(active(T0 + 120_000))).toBe(false);
    expect(isDurationOngoing(incident())).toBe(false);
  });

  it('titles an incident by its patterns, or else its first signal', () => {
    expect(incidentTitle(incident({ matchedPatterns: ['retry_storm'] }))).toBe('Retry Storm');
    expect(
      incidentTitle(
        incident({
          entries: [
            entry({ anomalyId: 'b', metricType: 'memory_used', timestamp: T0 + 5 }),
            entry({ anomalyId: 'a', metricType: 'connections', timestamp: T0 }),
          ],
        }),
      ),
    ).toBe('Connections');
    expect(incidentTitle(incident({ entries: [] }))).toBe('Incident');
  });
});
