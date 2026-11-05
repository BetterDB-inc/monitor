import type { IncidentTimeline, IncidentTimelineEntry } from '../../../types/anomaly';

export const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);

export function entry(overrides: Partial<IncidentTimelineEntry> = {}): IncidentTimelineEntry {
  return {
    anomalyId: 'a1',
    connectionId: 'conn-1',
    timestamp: T0,
    metricType: 'connections',
    severity: 'warning',
    message: 'Connections spiked',
    recoveredAt: null,
    recoveryState: 'open',
    ...overrides,
  };
}

export function incident(overrides: Partial<IncidentTimeline> = {}): IncidentTimeline {
  return {
    incidentId: `${T0}-0123456789abcdef`,
    scope: 'conn-1',
    connectionIds: ['conn-1'],
    startedAt: T0,
    lastEventAt: T0 + 60_000,
    entries: [entry()],
    sequence: ['connections'],
    matchedPatterns: [],
    sequenceMatches: [],
    recovery: {
      status: 'recovered',
      openSignals: [],
      unknownSignals: [],
      recoveredAt: T0 + 120_000,
    },
    ...overrides,
  };
}
