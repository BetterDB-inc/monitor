import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Connection } from '../../hooks/useConnection';
import { ConnectionSwitcher } from './ConnectionSwitcher';
import { ConnectionSwitcherOpenContext } from './switcher-open-context';

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
  const originalScrollIntoView = Element.prototype.scrollIntoView;

  beforeEach(() => {
    onSelect.mockClear();
  });

  afterEach(() => {
    // Restored rather than left installed: this is a prototype method, so a
    // stub leaks into every later test sharing the worker.
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

  it('opens when a shortcut requests it through the shared context', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <ConnectionSwitcherOpenContext.Provider value={{ open, setOpen }}>
          <button onClick={() => setOpen(true)}>request</button>
          <ConnectionSwitcher
            connections={CONNECTIONS}
            current={CONNECTIONS[0]}
            onSelect={onSelect}
          />
        </ConnectionSwitcherOpenContext.Provider>
      );
    }

    render(<Harness />);
    expect(screen.queryByRole('option')).toBeNull();

    fireEvent.click(screen.getByText('request'));

    expect(optionNames()).toHaveLength(3);
  });

  it('honours a request that was made before it mounted', () => {
    // Mod+K has to reveal the sidebar first, and on mobile that sidebar is a
    // Sheet whose contents do not exist while closed — so the request always
    // predates this component. Holding it above the switcher is what stops the
    // shortcut being a no-op there.
    render(
      <ConnectionSwitcherOpenContext.Provider value={{ open: true, setOpen: () => {} }}>
        <ConnectionSwitcher
          connections={CONNECTIONS}
          current={CONNECTIONS[0]}
          onSelect={onSelect}
        />
      </ConnectionSwitcherOpenContext.Provider>,
    );

    expect(optionNames()).toHaveLength(3);
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

  it('scrolls the highlighted row into view when navigating by keyboard', () => {
    // The list is height-capped and scrollable, which is the whole point for a
    // long connection list — a highlight that never scrolls is unusable.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    open();
    // Opening scrolls too, so the assertion has to isolate the navigation.
    scrollIntoView.mockClear();

    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' });

    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('does not let the row under a stationary cursor steal the keyboard highlight', () => {
    // Arrow keys scroll the list, so the browser fires mouseenter on whatever
    // row slides under the motionless pointer. Honouring that yanks the
    // highlight away from where the keyboard is.
    open();
    const search = screen.getByRole('searchbox');

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.mouseEnter(screen.getAllByRole('option')[2]);
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('follows the mouse again once it actually moves', () => {
    open();
    const search = screen.getByRole('searchbox');
    fireEvent.keyDown(search, { key: 'ArrowDown' });

    // Real movement produces a stream of events at changing coordinates; a
    // single event cannot be told apart from one a scroll emitted.
    const listbox = screen.getByRole('listbox');
    fireEvent.mouseMove(listbox, { clientX: 10, clientY: 10 });
    fireEvent.mouseMove(listbox, { clientX: 24, clientY: 31 });
    fireEvent.mouseEnter(screen.getAllByRole('option')[2]);
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('c');
  });

  it('points assistive technology at the highlighted option, not the current one', () => {
    // aria-selected marks the connection in use; it says nothing about where
    // the keyboard is, so arrow navigation is invisible to a screen reader.
    open();
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' });

    const active = screen.getByRole('searchbox').getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    expect(screen.getAllByRole('option')[1].id).toBe(active);
  });

  it('keeps Enter working when the connection list shrinks while open', () => {
    // refreshConnections can land at any moment; an activeIndex left pointing
    // past the end makes Enter silently do nothing.
    const { rerender } = render(
      <ConnectionSwitcher connections={CONNECTIONS} current={CONNECTIONS[0]} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByRole('combobox'));
    const search = screen.getByRole('searchbox');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });

    rerender(
      <ConnectionSwitcher
        connections={[CONNECTIONS[0]]}
        current={CONNECTIONS[0]}
        onSelect={onSelect}
      />,
    );
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('re-scrolls when filtering changes which rows are on screen', () => {
    // Filtering while the highlight stays at index 0 changes neither the index
    // nor the open state, so a stale scroll offset can leave the active row
    // out of view on a list the user had already scrolled.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    open();
    scrollIntoView.mockClear();

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'local' } });

    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('ignores a mousemove that did not actually move', () => {
    // Scrolling under a stationary cursor can emit mousemove without the
    // pointer going anywhere. Treating that as mouse intent hands the
    // highlight back and undoes the keyboard guard.
    open();
    const search = screen.getByRole('searchbox');
    fireEvent.keyDown(search, { key: 'ArrowDown' });

    const listbox = screen.getByRole('listbox');
    fireEvent.mouseMove(listbox, { clientX: 10, clientY: 10 });
    fireEvent.mouseMove(listbox, { clientX: 10, clientY: 10 });
    fireEvent.mouseEnter(screen.getAllByRole('option')[2]);
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('moves the highlight on the first ArrowUp after the list shrinks', () => {
    // ArrowUp decremented the raw index while the visible highlight follows
    // the clamped one, so after a shrink several presses did nothing.
    const { rerender } = render(
      <ConnectionSwitcher connections={CONNECTIONS} current={CONNECTIONS[0]} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByRole('combobox'));
    const search = screen.getByRole('searchbox');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });

    rerender(
      <ConnectionSwitcher
        connections={CONNECTIONS.slice(0, 2)}
        current={CONNECTIONS[0]}
        onSelect={onSelect}
      />,
    );
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowUp' });
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('shows connection health per row', () => {
    open();

    expect(screen.getByTestId('conn-status-b')).toHaveAttribute('data-connected', 'false');
    expect(screen.getByTestId('conn-status-a')).toHaveAttribute('data-connected', 'true');
  });
});
