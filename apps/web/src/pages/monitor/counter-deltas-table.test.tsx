import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  CAPTURE_COUNTER_FIELDS,
  type CaptureCounterDeltas,
  type CaptureCounterName,
} from '@betterdb/shared';
import { formatBytes } from '../../lib/utils';
import { CounterDeltasTable } from './counter-deltas-table';

afterEach(cleanup);

function deltas(
  overrides: Partial<Omit<CaptureCounterDeltas, 'deltas'>> & {
    deltas?: Partial<Record<CaptureCounterName, number | null>>;
  } = {},
): CaptureCounterDeltas {
  const base = {} as Record<CaptureCounterName, number | null>;
  for (const name of CAPTURE_COUNTER_FIELDS) {
    base[name] = null;
  }
  return {
    coverage: 'complete',
    nodesTotal: 1,
    nodesMeasured: 1,
    windowMs: 10_000,
    resets: [],
    derived: { commandsPerSec: null, keyspaceHitRatio: null },
    ...overrides,
    deltas: { ...base, ...overrides.deltas },
  };
}

function unavailable(): CaptureCounterDeltas {
  return deltas({ coverage: 'unavailable', nodesTotal: 0, nodesMeasured: 0, windowMs: null });
}

describe('CounterDeltasTable', () => {
  it('shows only the not-recorded text when unavailable without a baseline', () => {
    const { container } = render(<CounterDeltasTable deltas={unavailable()} />);
    expect(screen.getByTestId('counter-coverage').textContent).toContain('Not recorded');
    expect(container.querySelector('table')).toBeNull();
  });

  it('renders deltas, derived rates and coverage for a complete capture', () => {
    render(
      <CounterDeltasTable
        deltas={deltas({
          derived: { commandsPerSec: 200, keyspaceHitRatio: 0.9 },
          deltas: { total_commands_processed: 2000, rejected_connections: 3 },
        })}
      />,
    );
    expect(screen.getByTestId('counter-coverage').textContent).toContain('Δ over 10.0s across 1 node');
    expect(screen.getByText('Commands / sec').nextSibling?.textContent).toBe('200.0');
    expect(screen.getByText('Keyspace hit ratio').nextSibling?.textContent).toBe('90.0%');
    expect(screen.getByText('Rejected connections').nextSibling?.textContent).toBe('3');
  });

  it('formats byte counters with formatBytes', () => {
    render(<CounterDeltasTable deltas={deltas({ deltas: { total_net_output_bytes: 8192 } })} />);
    expect(screen.getByText('Network out').nextSibling?.textContent).toBe(formatBytes(8192));
  });

  it('omits rows that are null on every side', () => {
    render(<CounterDeltasTable deltas={deltas({ deltas: { evicted_keys: 1 } })} />);
    expect(screen.getByText('Evicted keys')).toBeTruthy();
    expect(screen.queryByText('Full resyncs')).toBeNull();
  });

  it('mentions unmeasured nodes and counter resets for partial coverage', () => {
    render(
      <CounterDeltasTable
        deltas={deltas({
          coverage: 'partial',
          nodesTotal: 2,
          nodesMeasured: 1,
          resets: [{ node: 'h1:6379', counters: ['keyspace_hits'] }],
          deltas: { keyspace_misses: 4 },
        })}
      />,
    );
    const text = screen.getByTestId('counter-coverage').textContent ?? '';
    expect(text).toContain('1 of 2 nodes not measured');
    expect(text).toContain('counter reset on h1:6379 (excluded)');
  });

  it('adds a baseline column and shows baseline-only rows with a dash on the current side', () => {
    render(
      <CounterDeltasTable
        deltas={deltas({ deltas: { evicted_keys: 2 } })}
        baseline={deltas({ deltas: { evicted_keys: 5, sync_full: 1 } })}
      />,
    );
    expect(screen.getByText('This capture')).toBeTruthy();
    expect(screen.getByText('Baseline capture')).toBeTruthy();
    expect(screen.getByTestId('counter-baseline-coverage')).toBeTruthy();
    const row = screen.getByText('Full resyncs').closest('tr');
    const cells = Array.from(row?.querySelectorAll('td') ?? []).map((c) => c.textContent);
    expect(cells).toEqual(['Full resyncs', '—', '1']);
  });

  it('still renders the table when only the baseline is available', () => {
    const { container } = render(
      <CounterDeltasTable
        deltas={unavailable()}
        baseline={deltas({ deltas: { expired_keys: 9 } })}
      />,
    );
    expect(container.querySelector('table')).not.toBeNull();
    expect(screen.getByText('Expired keys')).toBeTruthy();
  });
});
