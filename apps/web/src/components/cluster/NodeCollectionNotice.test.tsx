import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ComponentProps } from 'react';

const mocks = vi.hoisted(() => ({
  connectClusterNode: vi.fn(),
  canMutate: true,
}));

vi.mock('../../api/connections', () => ({
  connectionsApi: { connectClusterNode: mocks.connectClusterNode },
}));
vi.mock('../../hooks/useCanMutate', () => ({ useCanMutate: () => mocks.canMutate }));

import { NodeCollectionNotice } from './NodeCollectionNotice';

type Props = ComponentProps<typeof NodeCollectionNotice>;

const NODE_ID = 'b'.repeat(40);
const BUTTON = 'Connect to this node';

function renderNotice(overrides: Partial<Props> = {}) {
  const onConnected = vi.fn();
  render(
    <MemoryRouter>
      <NodeCollectionNotice
        nodeId={NODE_ID}
        address="10.0.0.2:6379"
        collection={{ collected: false }}
        clusterConnection={{ id: 'conn-1', host: '10.0.0.1', connectionType: 'direct' }}
        onConnected={onConnected}
        {...overrides}
      />
    </MemoryRouter>,
  );
  return onConnected;
}

describe('NodeCollectionNotice', () => {
  beforeEach(() => {
    mocks.connectClusterNode.mockReset();
    mocks.canMutate = true;
  });

  it('says what is missing for a node without its own connection and offers to connect it', () => {
    renderNotice();

    expect(
      screen.getByText(
        '10.0.0.2:6379 is not registered as its own connection. BetterDB only reads it through the cluster connection, so its slow log, client list and per-node metrics are missing.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Every node you connect is polled on its own, and the load that adds grows with the size of the cluster.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: BUTTON })).toBeEnabled();
  });

  it('connects the node through the cluster connection and links to its dashboard', async () => {
    mocks.connectClusterNode.mockResolvedValue({ id: 'conn-node', created: true });
    const onConnected = renderNotice();

    fireEvent.click(screen.getByRole('button', { name: BUTTON }));

    expect(mocks.connectClusterNode).toHaveBeenCalledWith('conn-1', NODE_ID);
    expect(await screen.findByRole('link', { name: 'Open node dashboard' })).toHaveAttribute(
      'href',
      '/?connection=conn-node',
    );
    expect(screen.queryByRole('button', { name: BUTTON })).not.toBeInTheDocument();
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it('cannot be clicked twice while it connects', async () => {
    let finish: (value: { id: string; created: boolean }) => void = () => {};
    mocks.connectClusterNode.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderNotice();

    fireEvent.click(screen.getByRole('button', { name: BUTTON }));

    const busy = screen.getByRole('button', { name: 'Connecting…' });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(mocks.connectClusterNode).toHaveBeenCalledTimes(1);

    finish({ id: 'conn-node', created: true });
    await screen.findByRole('link', { name: 'Open node dashboard' });
  });

  it('shows why the node could not be connected and lets the user try again', async () => {
    mocks.connectClusterNode.mockRejectedValue(
      new Error('Could not connect to 10.0.0.2:6379: connect ECONNREFUSED'),
    );
    const onConnected = renderNotice();

    fireEvent.click(screen.getByRole('button', { name: BUTTON }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not connect to 10.0.0.2:6379: connect ECONNREFUSED',
    );
    expect(screen.getByRole('button', { name: BUTTON })).toBeEnabled();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('names the address when the reason does not', async () => {
    mocks.connectClusterNode.mockRejectedValue(new Error('Another cluster owns this address.'));
    renderNotice();

    fireEvent.click(screen.getByRole('button', { name: BUTTON }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '10.0.0.2:6379 was not connected. Another cluster owns this address.',
    );
  });

  it.each([
    ['an agent', { id: 'conn-1', host: 'agent', connectionType: 'agent' as const }],
    ['OTLP push', { id: 'conn-1', host: 'otlp', connectionType: 'external' as const }],
  ])('offers no button when the cluster is read through %s', (_how, clusterConnection) => {
    renderNotice({ clusterConnection });

    expect(screen.queryByRole('button', { name: BUTTON })).not.toBeInTheDocument();
    expect(
      screen.getByText(/BetterDB does not open connections to the nodes of this cluster itself/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'How nodes get registered' })).toHaveAttribute(
      'href',
      'https://docs.betterdb.com/cluster-auto-registration.html',
    );
  });

  it('offers no button to a user who cannot change connections', () => {
    mocks.canMutate = false;
    renderNotice();

    expect(screen.queryByRole('button', { name: BUTTON })).not.toBeInTheDocument();
    expect(screen.getByText('Only an admin can connect a node.')).toBeInTheDocument();
  });

  it('links to the dashboard of a node that has its own connection', () => {
    renderNotice({ collection: { collected: true, connectionId: 'conn-node' } });

    expect(screen.getByRole('link', { name: 'Open node dashboard' })).toHaveAttribute(
      'href',
      '/?connection=conn-node',
    );
    expect(screen.queryByRole('button', { name: BUTTON })).not.toBeInTheDocument();
  });

  it('shows nothing for the node the cluster connection itself is on', () => {
    const { container } = render(
      <MemoryRouter>
        <NodeCollectionNotice
          nodeId={NODE_ID}
          address="10.0.0.1:6379"
          collection={{ collected: true, connectionId: 'conn-1' }}
          clusterConnection={{ id: 'conn-1', host: '10.0.0.1', connectionType: 'direct' }}
        />
      </MemoryRouter>,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing until it is known whether the node is collected', async () => {
    renderNotice({ collection: undefined });

    await waitFor(() => expect(screen.queryByRole('button')).not.toBeInTheDocument());
    expect(screen.queryByText(/not registered/)).not.toBeInTheDocument();
  });
});
