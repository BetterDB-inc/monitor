import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Connection } from '../../hooks/useConnection';
import { ConnectionSwitcher } from './ConnectionSwitcher';

function connection(over: Partial<Connection> & { id: string }): Connection {
  return {
    name: `conn-${over.id}`,
    host: 'localhost',
    port: 6379,
    isConnected: true,
    ...over,
  } as Connection;
}

const CONNECTIONS: Connection[] = [
  connection({ id: 'a', name: 'production-eu', host: '10.0.0.1', port: 6379 }),
  connection({ id: 'b', name: 'staging', host: '10.0.0.2', port: 6380, isConnected: false }),
  connection({ id: 'c', name: 'local-dev', host: 'localhost', port: 6381 }),
];

const onSelect = vi.fn();

function open(connections: Connection[] = CONNECTIONS, current = CONNECTIONS[0]) {
  render(<ConnectionSwitcher connections={connections} current={current} onSelect={onSelect} />);
  fireEvent.click(screen.getByRole('combobox'));
}

function optionNames(): string[] {
  return screen.getAllByRole('option').map((el) => el.textContent ?? '');
}

describe('ConnectionSwitcher', () => {
  beforeEach(() => {
    onSelect.mockClear();
  });

  it('shows the current connection on the trigger without opening', () => {
    render(
      <ConnectionSwitcher connections={CONNECTIONS} current={CONNECTIONS[0]} onSelect={onSelect} />,
    );

    expect(screen.getByRole('combobox')).toHaveTextContent('production-eu');
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('lists every connection when opened', () => {
    open();

    expect(optionNames()).toHaveLength(3);
  });

  it('filters by name', () => {
    open();

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'stag' } });

    expect(optionNames().join()).toContain('staging');
    expect(optionNames()).toHaveLength(1);
  });

  it('filters by host and port, not just name', () => {
    // An operator who remembers the port but not the label is the case a
    // scrolling dropdown handles worst.
    open();

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '6381' } });

    expect(optionNames().join()).toContain('local-dev');
    expect(optionNames()).toHaveLength(1);
  });

  it('matches case-insensitively', () => {
    open();

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'PRODUCTION' } });

    expect(optionNames()).toHaveLength(1);
  });

  it('selects a filtered result by its id, not its position', () => {
    open();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'local' } });

    fireEvent.click(screen.getAllByRole('option')[0]);

    expect(onSelect).toHaveBeenCalledWith('c');
  });

  it('distinguishes no matches from no connections', () => {
    open();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nothing-matches' } });

    expect(screen.getByText(/no connections match/i)).toBeInTheDocument();
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('marks the current connection', () => {
    open();

    const selected = screen.getAllByRole('option', { selected: true });
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent('production-eu');
  });

  it('moves through filtered results with the arrow keys and selects with Enter', () => {
    open();
    const search = screen.getByRole('searchbox');

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('keeps arrow navigation inside the filtered set', () => {
    // Navigating the unfiltered list while a filter is showing would select
    // something the operator cannot see.
    open();
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'local' } });

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('c');
  });

  it('does not select anything on Enter when nothing matches', () => {
    open();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });

    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('starts from the first row again after close and reopen', () => {
    // Closing cleared the query but kept the highlight, so reopening and
    // pressing Enter selected a row the operator never highlighted.
    render(
      <ConnectionSwitcher connections={CONNECTIONS} current={CONNECTIONS[0]} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });

    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('does not drive the highlight negative when nothing matches', () => {
    open();
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'zzz' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });

    // Clearing the filter must land back on a real row, not an index of -1.
    fireEvent.change(search, { target: { value: '' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('scrolls the highlighted row into view', () => {
    // The list is height-capped and scrollable, which is the whole point for a
    // long connection list — a highlight that never scrolls is unusable.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    open();

    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' });

    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('shows connection health per row', () => {
    open();

    expect(screen.getByTestId('conn-status-b')).toHaveAttribute('data-connected', 'false');
    expect(screen.getByTestId('conn-status-a')).toHaveAttribute('data-connected', 'true');
  });
});
