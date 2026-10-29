import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { SessionList } from '../SessionList';
import { listResponse } from './fixtures';
import { renderHookWithQuery } from '../../../../test/test-utils';
import { useOversizeSessions } from '../../../../hooks/useSessionExplorer';
import { sessionExplorerApi } from '../../../../api/session-explorer';

vi.mock('../../../../api/session-explorer', () => ({
  sessionExplorerApi: { oversize: vi.fn() },
}));

const order = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0].textContent?.replace('Oversize', '').trim());

const renderList = (props: Partial<Parameters<typeof SessionList>[0]> = {}) =>
  render(
    <SessionList
      data={listResponse()}
      oversizeIds={null}
      selectedId={null}
      onSelect={vi.fn()}
      {...props}
    />,
  );

describe('SessionList', () => {
  it('sorts by last access by default, most recent first', () => {
    renderList();
    expect(order()).toEqual(['bravo', 'alpha', 'charlie']);
  });

  it('sorts by size when the size header is clicked, toggling direction', () => {
    renderList();
    fireEvent.click(screen.getByRole('button', { name: /Size/ }));
    expect(order()).toEqual(['bravo', 'alpha', 'charlie']);
    fireEvent.click(screen.getByRole('button', { name: /Size/ }));
    expect(order()).toEqual(['charlie', 'alpha', 'bravo']);
  });

  it('sorts by TTL with persistent sessions last', () => {
    renderList();
    fireEvent.click(screen.getByRole('button', { name: /TTL/ }));
    expect(order()).toEqual(['charlie', 'alpha', 'bravo']);
  });

  it('returns to last access ordering', () => {
    renderList();
    fireEvent.click(screen.getByRole('button', { name: /TTL/ }));
    fireEvent.click(screen.getByRole('button', { name: /Last access/ }));
    expect(order()).toEqual(['bravo', 'alpha', 'charlie']);
  });

  it('opens a session from the keyboard', () => {
    const onSelect = vi.fn();
    renderList({ onSelect });
    const row = screen.getByText('alpha').closest('tr')!;
    expect(row.tabIndex).toBe(0);
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    fireEvent.keyDown(row, { key: 'a' });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenCalledWith('alpha');
  });

  it('marks the selected row', () => {
    renderList({ selectedId: 'alpha' });
    expect(screen.getByText('alpha').closest('tr')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('bravo').closest('tr')).toHaveAttribute('aria-selected', 'false');
  });

  it('announces the sort order on the sorted column only', () => {
    renderList();
    const header = (name: RegExp) => screen.getByRole('button', { name }).closest('th')!;
    expect(header(/Last access/)).toHaveAttribute('aria-sort', 'ascending');
    expect(header(/Size/)).not.toHaveAttribute('aria-sort');
    fireEvent.click(screen.getByRole('button', { name: /Size/ }));
    expect(header(/Size/)).toHaveAttribute('aria-sort', 'descending');
    expect(header(/Last access/)).not.toHaveAttribute('aria-sort');
  });

  it('notices a capped scan', () => {
    renderList({ data: listResponse({ truncated: true }) });
    expect(screen.getByText(/Showing the first 10,000 keys/)).toBeInTheDocument();
  });

  it('keeps scan warnings visible when no session matched', () => {
    renderList({ data: listResponse({ sessions: [], truncated: true, partial: true, failedNodes: 1 }) });
    expect(screen.getByText(/No sessions match this pattern/)).toBeInTheDocument();
    expect(screen.getByText(/first 10,000 keys/)).toBeInTheDocument();
    expect(screen.getByText(/1 node did not respond/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('warns about partial results naming the failed node count', () => {
    renderList({ data: listResponse({ partial: true, failedNodes: 2 }) });
    expect(screen.getByText(/2 nodes did not respond/)).toBeInTheDocument();
  });

  it('explains unknown last access under an LFU eviction policy', () => {
    renderList({ data: listResponse({ idleUntracked: true }) });
    expect(screen.getByText(/LFU eviction policy/)).toBeInTheDocument();
  });

  it('shows no notices for a complete scan', () => {
    renderList();
    expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument();
    expect(screen.queryByText(/did not respond/)).not.toBeInTheDocument();
    expect(screen.queryByText(/LFU eviction policy/)).not.toBeInTheDocument();
  });

  it('badges only sessions in the oversize list', () => {
    renderList({ oversizeIds: new Set(['alpha']) });
    const rows = screen.getAllByRole('row').slice(1);
    const badged = rows.filter((row) => within(row).queryByText('Oversize'));
    expect(badged).toHaveLength(1);
    expect(badged[0].textContent).toContain('alpha');
  });

  it('marks sizes that leave out keys whose memory could not be measured', () => {
    const base = listResponse();
    renderList({
      data: listResponse({
        sessions: [{ ...base.sessions[0], unmeasuredKeys: 2 }, base.sessions[1]],
      }),
    });
    const marked = screen.getByTitle('2 keys could not be measured');
    expect(marked.textContent).toBe('≥ 300.00 B');
    expect(screen.getAllByTitle(/could not be measured/)).toHaveLength(1);
  });

  it('shows no badge when not entitled', () => {
    renderList({ oversizeIds: null });
    expect(screen.queryByText('Oversize')).not.toBeInTheDocument();
  });

  it('selects a session on click', () => {
    const onSelect = vi.fn();
    renderList({ onSelect });
    fireEvent.click(screen.getByText('charlie'));
    expect(onSelect).toHaveBeenCalledWith('charlie');
  });
});

describe('SessionList search and paging', () => {
  const many = (count: number, prefix = '') =>
    listResponse({
      sessions: Array.from({ length: count }, (_, i) => ({
        sessionId: `${prefix}session-${String(i).padStart(3, '0')}`,
        keyCount: 1,
        memoryBytes: 100,
        unmeasuredKeys: 0,
        idleSeconds: i,
        ttlMs: null,
      })),
    });

  it('filters sessions by id', () => {
    renderList();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter sessions' }), {
      target: { value: 'RAV' },
    });
    expect(order()).toEqual(['bravo']);
  });

  it('says when no session matches the filter', () => {
    renderList();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter sessions' }), {
      target: { value: 'zulu' },
    });
    expect(screen.getByText('No sessions match this filter.')).toBeInTheDocument();
  });

  it('shows 50 sessions at a time and loads more on request', () => {
    renderList({ data: many(120) });
    expect(screen.getAllByRole('row')).toHaveLength(51);
    fireEvent.click(screen.getByRole('button', { name: 'Show more (70 remaining)' }));
    expect(screen.getAllByRole('row')).toHaveLength(101);
  });

  it('shows ids without the namespace prefix and keeps the full key as a tooltip', () => {
    const onSelect = vi.fn();
    renderList({ data: many(1, 'message_store:'), idPrefix: 'message_store:', onSelect });
    const id = screen.getByText('session-000');
    expect(id).toHaveAttribute('title', 'message_store:session-000');
    fireEvent.click(id);
    expect(onSelect).toHaveBeenCalledWith('message_store:session-000');
  });

  it('matches the filter against the id it shows, not the hidden prefix', () => {
    renderList({ data: many(3, 'message_store:'), idPrefix: 'message_store:' });
    const search = screen.getByRole('searchbox', { name: 'Filter sessions' });
    fireEvent.change(search, { target: { value: 'store' } });
    expect(screen.getByText('No sessions match this filter.')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'session-001' } });
    expect(order()).toEqual(['session-001']);
  });

  it('clears the filter but keeps the sort when the namespace changes', () => {
    const props = { data: listResponse(), oversizeIds: null, selectedId: null, onSelect: vi.fn() };
    const { rerender } = render(<SessionList {...props} namespaceId="a" />);
    fireEvent.click(screen.getByRole('button', { name: /Size/ }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter sessions' }), {
      target: { value: 'a' },
    });

    rerender(<SessionList {...props} namespaceId="b" />);

    expect(screen.getByRole('searchbox', { name: 'Filter sessions' })).toHaveValue('');
    expect(order()).toEqual(['bravo', 'alpha', 'charlie']);
  });

  it('only fixes the column widths on wide screens, so narrow screens keep the whole id', () => {
    renderList();
    const table = screen.getByRole('table');
    expect(table).toHaveClass('lg:table-fixed');
    expect(table).not.toHaveClass('table-fixed');
    expect(screen.getByText('alpha')).toHaveClass('break-all');
  });
});

describe('useOversizeSessions', () => {
  const oversize = vi.mocked(sessionExplorerApi.oversize);

  beforeEach(() => {
    oversize.mockReset();
    oversize.mockResolvedValue({ thresholdBytes: 1, sessionIds: ['alpha'], truncated: false });
  });

  it('does not call the oversize endpoint when not entitled', async () => {
    const { result } = renderHookWithQuery(() => useOversizeSessions('conn-1', 'ns-1', false));
    await new Promise((r) => setTimeout(r, 20));
    expect(oversize).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it('returns the oversize ids when entitled', async () => {
    const { result } = renderHookWithQuery(() => useOversizeSessions('conn-1', 'ns-1', true));
    await waitFor(() => expect(result.current).toEqual(new Set(['alpha'])));
    expect(oversize).toHaveBeenCalledWith('ns-1', expect.anything());
  });
});
