import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { listConnectionNodes, preflight, startSession } = vi.hoisted(() => ({
  listConnectionNodes: vi.fn(),
  preflight: vi.fn(),
  startSession: vi.fn(),
}));

vi.mock('../../api/monitor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/monitor')>();
  return { ...actual, monitorApi: { listConnectionNodes, preflight, startSession } };
});
vi.mock('./preflight-panel', () => ({ PreflightPanel: () => <div>pre-flight report</div> }));

import { StartSessionModal } from './start-session-modal';

function renderModal(props: Partial<Parameters<typeof StartSessionModal>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onStarted = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <StartSessionModal
        connectionId="conn-1"
        open
        onOpenChange={vi.fn()}
        onStarted={onStarted}
        {...props}
      />
    </QueryClientProvider>,
  );
  return onStarted;
}

async function start(): Promise<void> {
  const button = screen.getByRole('button', { name: 'Start session' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(startSession).toHaveBeenCalled());
}

describe('StartSessionModal', () => {
  beforeEach(() => {
    listConnectionNodes.mockReset().mockResolvedValue({
      isCluster: true,
      nodes: [
        { id: 'r1', address: '10.0.0.9:6379', role: 'replica', healthy: true },
        { id: 'm1', address: '10.0.0.1:6379', role: 'master', healthy: true },
        { id: 'm2', address: '10.0.0.2:6379', role: 'master', healthy: true },
      ],
    });
    preflight.mockReset().mockResolvedValue({});
    startSession.mockReset().mockResolvedValue({ id: 'sess-1' });
  });

  it('starts at 30 seconds on the first primary, with no hot primary warning', async () => {
    renderModal();

    expect(screen.getByLabelText('Duration')).toHaveValue(30);
    await screen.findByText('Cluster node');
    await start();

    expect(screen.queryByText(/already hot/)).not.toBeInTheDocument();
    expect(startSession.mock.calls[0][0]).toMatchObject({
      durationMs: 30_000,
      targetNodeId: 'm1',
    });
  });

  it('starts at 10 seconds on the hot primary it is given', async () => {
    renderModal({ hotPrimary: { nodeId: 'm2', address: '10.0.0.2:6379' } });

    expect(screen.getByLabelText('Duration')).toHaveValue(10);
    await start();

    expect(screen.getByText(/already hot \(10\.0\.0\.2:6379\)/)).toBeInTheDocument();
    expect(startSession.mock.calls[0][0]).toMatchObject({
      durationMs: 10_000,
      targetNodeId: 'm2',
    });
  });

  it('keeps a capture on the hot primary: no fan-out and no other node to pick', async () => {
    renderModal({ hotPrimary: { nodeId: 'm2', address: '10.0.0.2:6379' } });

    await waitFor(() => expect(listConnectionNodes).toHaveBeenCalled());
    await start();

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Cluster node')).not.toBeInTheDocument();
    expect(screen.getByText(/The capture runs on this primary only/)).toBeInTheDocument();
    expect(startSession).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      durationMs: 10_000,
      requestedBy: undefined,
      targetNodeId: 'm2',
      fanOut: undefined,
    });
  });

  it('fans out across the primaries when asked to, without a hot primary', async () => {
    renderModal();

    fireEvent.click(await screen.findByRole('checkbox'));
    await start();

    expect(startSession.mock.calls[0][0]).toMatchObject({ fanOut: true, targetNodeId: undefined });
  });

  it('sends no node for a connection that is not a cluster', async () => {
    listConnectionNodes.mockResolvedValue({ isCluster: false, nodes: [] });
    renderModal();

    await waitFor(() => expect(listConnectionNodes).toHaveBeenCalled());
    await start();

    expect(startSession.mock.calls[0][0].targetNodeId).toBeUndefined();
  });
});
