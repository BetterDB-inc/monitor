import { fireEvent, render, screen } from '@testing-library/react';
import type { CveSeverityCounts } from '@betterdb/shared';
import { describe, expect, it, vi } from 'vitest';
import { HeaderStrip } from './HeaderStrip';

const COUNTS: CveSeverityCounts = { critical: 2, high: 3, medium: 4, low: 5 };

function renderStrip(overrides: Partial<Parameters<typeof HeaderStrip>[0]> = {}) {
  const props = {
    subtitle: 'Valkey 8.0.9 · scanned 2h ago · advisories refreshed 1h ago',
    severityCounts: COUNTS,
    scopeLabel: null,
    refreshing: false,
    refreshError: null,
    onRefresh: vi.fn(),
    ...overrides,
  };

  render(<HeaderStrip {...props} />);

  return props;
}

describe('HeaderStrip', () => {
  it('renders each severity count the scan reported', () => {
    renderStrip();

    expect(screen.getByTestId('severity-badge-critical')).toHaveTextContent('2 critical');
    expect(screen.getByTestId('severity-badge-high')).toHaveTextContent('3 high');
    expect(screen.getByTestId('severity-badge-medium')).toHaveTextContent('4 medium');
    expect(screen.getByTestId('severity-badge-low')).toHaveTextContent('5 low');
  });

  it('does not paint a zero critical count as an alarm', () => {
    renderStrip({ severityCounts: { critical: 0, high: 1, medium: 0, low: 0 } });

    expect(screen.getByTestId('severity-badge-critical').className).not.toMatch(/bg-destructive/);
  });

  it('paints a non-zero critical count as an alarm', () => {
    renderStrip();

    expect(screen.getByTestId('severity-badge-critical').className).toMatch(/bg-destructive/);
  });

  it('says which nodes the badges cover when there is more than one', () => {
    renderStrip({ scopeLabel: 'across 3 nodes' });

    expect(screen.getByTestId('severity-scope')).toHaveTextContent('across 3 nodes');
  });

  it('omits the scope label for a single node', () => {
    renderStrip();

    expect(screen.queryByTestId('severity-scope')).not.toBeInTheDocument();
  });

  it('shows the scan age given to it, not only the dataset age', () => {
    renderStrip();

    expect(screen.getByTestId('header-subtitle')).toHaveTextContent('scanned 2h ago');
    expect(screen.getByTestId('header-subtitle')).toHaveTextContent('advisories refreshed 1h ago');
  });

  it('drops the badges when there is no scan to count', () => {
    renderStrip({ severityCounts: null, subtitle: 'Could not scan this connection for CVEs.' });

    expect(screen.queryByTestId('severity-badge-critical')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rescan' })).toBeInTheDocument();
  });

  it('says the results are stale when a rescan failed', () => {
    renderStrip({ refreshError: 'connection refused' });

    expect(screen.getByTestId('rescan-error')).toHaveTextContent('connection refused');
    expect(screen.getByTestId('rescan-error')).toHaveTextContent(/not a fresh one/i);
  });

  it('stays quiet when no rescan has failed', () => {
    renderStrip();

    expect(screen.queryByTestId('rescan-error')).not.toBeInTheDocument();
  });

  it('asks for a rescan when the button is clicked', () => {
    const props = renderStrip();

    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }));

    expect(props.onRefresh).toHaveBeenCalledTimes(1);
  });
});
