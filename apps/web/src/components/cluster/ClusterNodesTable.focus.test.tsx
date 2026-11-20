import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ClusterNode } from '../../types/metrics';
import { ClusterNodesTable } from './ClusterNodesTable';

function clusterNode(overrides: Partial<ClusterNode>): ClusterNode {
  return {
    id: 'a'.repeat(40),
    address: '10.0.0.1:6379',
    flags: ['master'],
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 1,
    linkState: 'connected',
    slots: [[0, 16383]],
    ...overrides,
  };
}

const primary = clusterNode({});
const replica = clusterNode({
  id: 'b'.repeat(40),
  address: '10.0.0.2:6379',
  flags: ['slave'],
  master: primary.id,
  slots: [],
});

function row(address: string): HTMLElement {
  return screen.getByText(address).closest('tr') as HTMLElement;
}

describe('ClusterNodesTable picked node', () => {
  const scrollIntoView = vi.fn();
  const original = Element.prototype.scrollIntoView;

  beforeEach(() => {
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  it('opens the row of the node it was asked for and scrolls to it', () => {
    render(<ClusterNodesTable nodes={[primary, replica]} focusNodeId={replica.id} />);

    expect(screen.getByText(replica.id)).toBeInTheDocument();
    expect(screen.queryByText(primary.id)).not.toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(row(replica.address));
  });

  it('opens no row when it was asked for none', () => {
    render(<ClusterNodesTable nodes={[primary, replica]} />);

    expect(screen.queryByText(primary.id)).not.toBeInTheDocument();
    expect(screen.queryByText(replica.id)).not.toBeInTheDocument();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('opens the row once the nodes arrive', () => {
    const { rerender } = render(<ClusterNodesTable nodes={[]} focusNodeId={replica.id} />);

    rerender(<ClusterNodesTable nodes={[primary, replica]} focusNodeId={replica.id} />);

    expect(screen.getByText(replica.id)).toBeInTheDocument();
  });

  it('drops a filter that hides the node', () => {
    const { rerender } = render(<ClusterNodesTable nodes={[primary, replica]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Masters' }));
    expect(screen.queryByText(replica.address)).not.toBeInTheDocument();

    rerender(<ClusterNodesTable nodes={[primary, replica]} focusNodeId={replica.id} />);

    expect(screen.getByText(replica.id)).toBeInTheDocument();
  });

  it('lets the row be closed and does not open it again on the next refresh', () => {
    const { rerender } = render(
      <ClusterNodesTable nodes={[primary, replica]} focusNodeId={replica.id} />,
    );

    fireEvent.click(row(replica.address));
    rerender(<ClusterNodesTable nodes={[{ ...primary }, { ...replica }]} focusNodeId={replica.id} />);

    expect(screen.queryByText(replica.id)).not.toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('moves to another node when asked for another one', () => {
    const { rerender } = render(
      <ClusterNodesTable nodes={[primary, replica]} focusNodeId={replica.id} />,
    );

    rerender(<ClusterNodesTable nodes={[primary, replica]} focusNodeId={primary.id} />);

    expect(screen.getByText(primary.id)).toBeInTheDocument();
    expect(screen.queryByText(replica.id)).not.toBeInTheDocument();
  });

  it('says so when the node is not in the cluster', () => {
    render(<ClusterNodesTable nodes={[primary, replica]} focusNodeId={'c'.repeat(40)} />);

    expect(screen.getByRole('status')).toHaveTextContent(
      'Node cccccccc is not in the current view of this cluster. It may have left the cluster.',
    );
  });

  it('says nothing about a missing node before the nodes arrive', () => {
    render(<ClusterNodesTable nodes={[]} focusNodeId={'c'.repeat(40)} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('ClusterNodesTable picked node while the page settles', () => {
  const scrollIntoView = vi.fn();
  const original = Element.prototype.scrollIntoView;
  const observers: Array<{ grow: () => void; watched: Element[]; stopped: boolean }> = [];

  class PageGrowth {
    private readonly entry: (typeof observers)[number];

    constructor(onGrow: () => void) {
      this.entry = { grow: onGrow, watched: [], stopped: false };
      observers.push(this.entry);
    }

    observe(target: Element): void {
      this.entry.watched.push(target);
    }

    unobserve(): void {}

    disconnect(): void {
      this.entry.stopped = true;
    }
  }

  function growPage(): void {
    for (const observer of observers) {
      if (!observer.stopped) observer.grow();
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    observers.length = 0;
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = scrollIntoView;
    vi.stubGlobal('ResizeObserver', PageGrowth);
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = original;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('brings the row back into view when the page grows above it', () => {
    render(<ClusterNodesTable nodes={[primary, replica]} focusNodeId={replica.id} />);
    expect(observers[0].watched).toEqual([document.body]);

    growPage();

    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scrollIntoView.mock.contexts[1]).toBe(row(replica.address));
  });

  it.each(['wheel', 'touchmove', 'keydown', 'pointerdown'])(
    'leaves the page where the reader put it after a %s',
    (input) => {
      render(<ClusterNodesTable nodes={[primary, replica]} focusNodeId={replica.id} />);

      fireEvent(window, new Event(input));
      growPage();

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    },
  );

  it('stops following the row after ten seconds', () => {
    render(<ClusterNodesTable nodes={[primary, replica]} focusNodeId={replica.id} />);

    vi.advanceTimersByTime(10_000);
    growPage();

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('stops following the row when the table goes away', () => {
    const { unmount } = render(<ClusterNodesTable nodes={[primary, replica]} focusNodeId={replica.id} />);

    unmount();

    expect(observers.every((observer) => observer.stopped)).toBe(true);
  });

  it('follows no row when it was asked for none', () => {
    render(<ClusterNodesTable nodes={[primary, replica]} />);

    expect(observers).toHaveLength(0);
  });
});
