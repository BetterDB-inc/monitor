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
    incompleteCounters: [],
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
    render(<CounterDeltasTable deltas={deltas({ deltas: { total_net_input_bytes: 8192 } })} />);
    expect(screen.getByText('Network in').nextSibling?.textContent).toBe(formatBytes(8192));
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
          nodesTotal: 3,
          nodesMeasured: 1,
          resets: [{ node: 'h1:6379', reason: 'counter_reset', counters: ['keyspace_hits'] }],
          deltas: { keyspace_misses: 4 },
        })}
      />,
    );
    const text = screen.getByTestId('counter-coverage').textContent ?? '';
    expect(text).toContain('1 of 3 nodes not measured');
    expect(text).toContain('stats reset: h1:6379 (excluded)');
  });

  it('names restarted nodes separately and does not count them as unmeasured', () => {
    render(
      <CounterDeltasTable
        deltas={deltas({
          coverage: 'partial',
          nodesTotal: 2,
          nodesMeasured: 1,
          resets: [{ node: 'h2:6379', reason: 'restart', counters: [] }],
        })}
      />,
    );
    const text = screen.getByTestId('counter-coverage').textContent ?? '';
    expect(text).toContain('restarted: h2:6379 (excluded)');
    expect(text).not.toContain('not measured');
  });

  it('lists counters reported by only some nodes', () => {
    render(
      <CounterDeltasTable
        deltas={deltas({
          coverage: 'partial',
          nodesTotal: 2,
          nodesMeasured: 2,
          incompleteCounters: ['total_error_replies'],
          deltas: { total_error_replies: 3 },
        })}
      />,
    );
    expect(screen.getByTestId('counter-coverage').textContent).toContain(
      'reported by only some nodes: Error replies',
    );
  });

  it('says counters are available when a running capture ends', () => {
    render(<CounterDeltasTable deltas={{ ...unavailable(), pending: 'capture_running' }} />);
    const text = screen.getByTestId('counter-coverage').textContent ?? '';
    expect(text).toContain('Available when the capture ends, if INFO responded at start');
    expect(text).not.toContain('predates');
  });

  it('explains an interrupted capture instead of the legacy text', () => {
    render(<CounterDeltasTable deltas={{ ...unavailable(), pending: 'capture_interrupted' }} />);
    const text = screen.getByTestId('counter-coverage').textContent ?? '';
    expect(text).toContain('the capture was interrupted');
    expect(text).not.toContain('predates');
  });

  it('explains when every node restarted or reset its stats', () => {
    render(
      <CounterDeltasTable
        deltas={deltas({
          coverage: 'unavailable',
          nodesTotal: 1,
          nodesMeasured: 0,
          windowMs: null,
          resets: [{ node: 'h1:6379', reason: 'restart', counters: [] }],
        })}
      />,
    );
    const text = screen.getByTestId('counter-coverage').textContent ?? '';
    expect(text).toContain('every sampled node restarted or reset its stats');
    expect(text).toContain('restarted: h1:6379');
  });

  it('does not claim every node reset when other nodes simply have no complete sample', () => {
    render(
      <CounterDeltasTable
        deltas={deltas({
          coverage: 'unavailable',
          nodesTotal: 2,
          nodesMeasured: 0,
          windowMs: null,
          resets: [{ node: 'h1:6379', reason: 'restart', counters: [] }],
        })}
      />,
    );
    const text = screen.getByTestId('counter-coverage').textContent ?? '';
    expect(text).toContain('1 of 2 nodes');
    expect(text).not.toContain('every sampled node');
  });

  it('shows both coverage reasons when this capture and the baseline are unavailable', () => {
    render(
      <CounterDeltasTable
        deltas={unavailable()}
        baseline={deltas({
          coverage: 'unavailable',
          nodesTotal: 1,
          nodesMeasured: 0,
          windowMs: null,
          resets: [{ node: 'h1:6379', reason: 'restart', counters: [] }],
        })}
      />,
    );
    expect(screen.getByTestId('counter-coverage').textContent).toContain('This capture:');
    expect(screen.getByTestId('counter-coverage').textContent).toContain('Not recorded');
    expect(screen.getByTestId('baseline-counter-coverage').textContent).toContain('restarted');
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
