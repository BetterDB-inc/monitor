import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CAPTURE_COUNTER_FIELDS, type CaptureCounterDeltas, type CaptureCounterName } from '@betterdb/shared';
import type { CrossReferenceResult } from '../../api/monitor';
import { CrossReferenceSections } from './cross-reference-panel';

afterEach(cleanup);

function counterDeltas(
  coverage: CaptureCounterDeltas['coverage'],
  values: Partial<Record<CaptureCounterName, number>> = {},
): CaptureCounterDeltas {
  const deltas = {} as Record<CaptureCounterName, number | null>;
  for (const name of CAPTURE_COUNTER_FIELDS) {
    deltas[name] = values[name] ?? null;
  }
  return {
    coverage,
    nodesTotal: coverage === 'unavailable' ? 0 : 1,
    nodesMeasured: coverage === 'unavailable' ? 0 : 1,
    windowMs: coverage === 'unavailable' ? null : 5_000,
    deltas,
    resets: [],
    incompleteCounters: [],
    derived: { commandsPerSec: null, keyspaceHitRatio: null },
  };
}

function result(overrides: Partial<CrossReferenceResult> = {}): CrossReferenceResult {
  return {
    sessionId: 's1',
    baseline: { window: '24h', startTs: 0, endTs: 1 },
    session: { startTs: 0, endTs: 1, capturedLineCount: 0 },
    newShapes: [],
    hotKeyDelta: { newInTopK: [], rankChanges: [] },
    slowlogRegressions: [],
    aclDeltas: {
      auditEntriesInWindow: 0,
      counters: { aclAccessDeniedAuthDelta: null, rejectedConnectionsDelta: null },
    },
    counterDeltas: counterDeltas('unavailable'),
    ...overrides,
  };
}

describe('CrossReferenceSections', () => {
  it('renders the INFO counters section', () => {
    render(<CrossReferenceSections result={result()} />);
    expect(screen.getByTestId('counter-deltas-section')).toBeTruthy();
    expect(screen.getByText('INFO counters during capture')).toBeTruthy();
  });

  it('explains unavailable counters and drops the old pending placeholder', () => {
    render(<CrossReferenceSections result={result()} />);
    expect(screen.getByText('INFO counters were not recorded for this capture.')).toBeTruthy();
    expect(screen.queryByText(/follow-up PR/)).toBeNull();
  });

  it('tells a running capture that counters arrive when it ends', () => {
    render(
      <CrossReferenceSections
        result={result({
          counterDeltas: { ...counterDeltas('unavailable'), pending: 'capture_running' },
        })}
      />,
    );
    expect(screen.getByText('INFO counters are available when the capture ends.')).toBeTruthy();
    expect(screen.queryByText('INFO counters were not recorded for this capture.')).toBeNull();
  });

  it('explains counters missing from an interrupted capture', () => {
    render(
      <CrossReferenceSections
        result={result({
          counterDeltas: { ...counterDeltas('unavailable'), pending: 'capture_interrupted' },
        })}
      />,
    );
    expect(
      screen.getByText('INFO counters were not recorded: the capture was interrupted before it ended.'),
    ).toBeTruthy();
  });

  it('renders populated ACL counters instead of dashes', () => {
    render(
      <CrossReferenceSections
        result={result({
          aclDeltas: {
            auditEntriesInWindow: 0,
            counters: { aclAccessDeniedAuthDelta: 3, rejectedConnectionsDelta: 2 },
          },
          counterDeltas: counterDeltas('complete', {
            acl_access_denied_auth: 3,
            rejected_connections: 2,
          }),
        })}
      />,
    );
    expect(screen.getByText('acl_access_denied_auth Δ').nextSibling?.textContent).toBe('3');
    expect(screen.getByText('rejected_connections Δ').nextSibling?.textContent).toBe('2');
    expect(screen.queryByText('INFO counters were not recorded for this capture.')).toBeNull();
  });
});
