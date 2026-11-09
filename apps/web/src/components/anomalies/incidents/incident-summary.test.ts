import { describe, expect, it } from 'vitest';
import { entry, incident, T0 } from './incident-fixtures';
import {
  dateRangeQuery,
  incidentDurationMs,
  incidentPath,
  incidentTitle,
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

  it('encodes the incident id in its path and keeps the date range', () => {
    expect(incidentPath('1-a/b')).toBe('/anomalies/incidents/1-a%2Fb');
    expect(incidentPath('1-a', dateRangeQuery(100, 200))).toBe(
      '/anomalies/incidents/1-a?start=100&end=200',
    );
    expect(dateRangeQuery(100, undefined)).toBe('');
  });

  it('keeps the duration running while an incident is still active', () => {
    const active = incident({
      recovery: {
        status: 'active',
        openSignals: [],
        unknownSignals: [],
        recoveredAt: T0 + 120_000,
      },
    });
    expect(incidentDurationMs(active, T0 + 300_000)).toBe(300_000);
  });

  it('titles an incident by its patterns, or else its first signal', () => {
    expect(incidentTitle(incident({ matchedPatterns: ['retry_storm'] }))).toBe('Retry Storm');
    expect(
      incidentTitle(incident({ matchedPatterns: ['retry_storm', 'split_brain', 'retry_storm'] })),
    ).toBe('Retry Storm, Split Brain');
    expect(
      incidentTitle(
        incident({
          entries: [
            entry({ anomalyId: 'a', metricType: 'connections', timestamp: T0 }),
            entry({ anomalyId: 'b', metricType: 'memory_used', timestamp: T0 + 5 }),
          ],
        }),
      ),
    ).toBe('Connections');
    expect(incidentTitle(incident({ entries: [] }))).toBe('Incident');
  });
});
