import { describe, expect, it } from 'vitest';
import { entry, incident, T0 } from './incident-fixtures';
import {
  findIncidentForAnomalies,
  incidentDurationMs,
  incidentPath,
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
    expect(findIncidentForAnomalies([incident(), target], ['y', 'x'])).toBe(target);
    expect(findIncidentForAnomalies([incident()], ['z'])).toBeUndefined();
    expect(findIncidentForAnomalies(undefined, ['x'])).toBeUndefined();
  });

  it('encodes the incident id in its path', () => {
    expect(incidentPath('1-a/b')).toBe('/anomalies/incidents/1-a%2Fb');
  });
});
