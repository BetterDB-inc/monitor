import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ServedClusterNodeRef } from '@betterdb/shared';
import { NodeLink } from './NodeLink';

function node(overrides: Partial<ServedClusterNodeRef> = {}): ServedClusterNodeRef {
  return {
    nodeId: 'a'.repeat(40),
    address: '10.0.0.1:6379',
    role: 'primary',
    collected: true,
    connectionId: 'conn-node',
    ...overrides,
  };
}

function renderLink(ref: ServedClusterNodeRef, connectionId?: string, onRowClick = vi.fn()) {
  render(
    <MemoryRouter>
      <div onClick={onRowClick}>
        <NodeLink node={ref} connectionId={connectionId} />
      </div>
    </MemoryRouter>,
  );
  return onRowClick;
}

describe('NodeLink', () => {
  it('links the address to the node in the cluster view of the connection that raised the event', () => {
    renderLink(node(), 'conn-1');

    expect(screen.getByRole('link', { name: '10.0.0.1:6379' })).toHaveAttribute(
      'href',
      `/cluster?tab=nodes&node=${'a'.repeat(40)}&connection=conn-1`,
    );
  });

  it('leaves the connection out of the link when the event has none', () => {
    renderLink(node());

    expect(screen.getByRole('link', { name: '10.0.0.1:6379' })).toHaveAttribute(
      'href',
      `/cluster?tab=nodes&node=${'a'.repeat(40)}`,
    );
  });

  it('shows the role, the shard and the zone when they are known', () => {
    renderLink(node({ role: 'replica', shardId: 'f'.repeat(40), availabilityZone: 'eu-west-1b' }));

    expect(screen.getByText('replica · shard ffffffff · eu-west-1b')).toBeInTheDocument();
  });

  it('shows only what is known', () => {
    renderLink(node({ role: 'unknown' }));

    expect(screen.queryByText(/primary|replica|unknown|shard/)).not.toBeInTheDocument();
  });

  it('nests validly in a paragraph when the node has no connection of its own', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <MemoryRouter>
          <p>
            <NodeLink node={node({ collected: false, connectionId: undefined })} />
          </p>
        </MemoryRouter>,
      );

      expect(screen.getByText('Not collected')).toBeInTheDocument();
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it('marks a node that has no connection of its own', () => {
    renderLink(node({ collected: false, connectionId: undefined }));

    expect(screen.getByText('Not collected')).toBeInTheDocument();
  });

  it('does not mark a collected node', () => {
    renderLink(node());

    expect(screen.queryByText('Not collected')).not.toBeInTheDocument();
  });

  it('does not pass a click on the link to the row around it', () => {
    const onRowClick = renderLink(node());

    fireEvent.click(screen.getByRole('link', { name: '10.0.0.1:6379' }));

    expect(onRowClick).not.toHaveBeenCalled();
  });
});
