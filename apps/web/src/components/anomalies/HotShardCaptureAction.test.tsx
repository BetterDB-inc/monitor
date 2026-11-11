import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import type { HotShardDetail } from '../../types/anomaly';

const { listConnectionNodes, preflight, startSession } = vi.hoisted(() => ({
  listConnectionNodes: vi.fn(),
  preflight: vi.fn(),
  startSession: vi.fn(),
}));

vi.mock('../../api/monitor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/monitor')>();
  return { ...actual, monitorApi: { listConnectionNodes, preflight, startSession } };
});
vi.mock('../../pages/monitor/preflight-panel', () => ({
  PreflightPanel: () => <div>pre-flight report</div>,
}));

import { HotShardCaptureAction } from './HotShardCaptureAction';

const EVENT = { id: 'evt-1', metricType: 'hot_shard', resolved: false };
const ACTION = 'Capture on hot primary';

function hotShard(overrides: Partial<HotShardDetail> = {}): HotShardDetail {
  return {
    eventId: 'evt-1',
    captureAvailable: true,
    shardId: 'a0000000',
    nodeAddr: '10.0.0.1:6379',
    slotCount: 2,
    since: 1_000,
    sampledAt: 61_000,
    cpu: { perSecond: 900_000, share: 0.82, median: 100_000, ratio: 9 },
    network: { perSecond: 0, share: 0, median: 0 },
    topSlots: [],
    topKeys: [],
    keySource: 'unavailable',
    keyNote: 'maxmemory-policy is not an LFU policy, so the node keeps no access frequency',
    keysSampled: 0,
    ...overrides,
  };
}

function SessionPage() {
  return <div>session {useParams().id}</div>;
}

type ActionProps = Partial<Parameters<typeof HotShardCaptureAction>[0]>;

function renderAction(props: ActionProps = {}): (next: ActionProps) => void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (current: ActionProps) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/anomalies']}>
        <Routes>
          <Route
            path="/anomalies"
            element={
              <HotShardCaptureAction
                event={EVENT}
                hotShards={[hotShard()]}
                connectionId="conn-1"
                {...current}
              />
            }
          />
          <Route path="/monitor/sessions/:id" element={<SessionPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const { rerender } = render(tree(props));
  return (next) => rerender(tree(next));
}

async function openDialog(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: ACTION }));
  await screen.findByText('Start MONITOR capture session');
  const start = screen.getByRole('button', { name: 'Start session' });
  await waitFor(() => expect(start).toBeEnabled());
  return start;
}

describe('HotShardCaptureAction', () => {
  beforeEach(() => {
    listConnectionNodes.mockReset().mockResolvedValue({
      isCluster: true,
      nodes: [
        { id: 'b0000000', address: '10.0.0.2:6379', role: 'master', healthy: true },
        { id: 'a0000000', address: '10.0.0.1:6379', role: 'master', healthy: true },
      ],
    });
    preflight.mockReset().mockResolvedValue({});
    startSession.mockReset().mockResolvedValue({ id: 'sess-9' });
  });

  it('offers a capture for an open hot shard whose key names are missing', () => {
    renderAction();

    expect(screen.getByRole('button', { name: ACTION })).toBeInTheDocument();
    expect(listConnectionNodes).not.toHaveBeenCalled();
  });

  it.each<[string, ActionProps]>([
    ['the hot shard list is still loading', { hotShards: undefined }],
    ['the hot shard list could not be read', { hotShards: null }],
    ['the hot shard list is empty', { hotShards: [] }],
    ['the list holds another event', { hotShards: [hotShard({ eventId: 'evt-2' })] }],
    ['a capture cannot help', { hotShards: [hotShard({ captureAvailable: false })] }],
    ['the event is resolved', { event: { ...EVENT, resolved: true } }],
    ['the event is not a hot shard', { event: { ...EVENT, metricType: 'memory_used' } }],
    ['no connection is selected', { connectionId: undefined }],
  ])('offers nothing when %s', (_case, props) => {
    renderAction(props);

    expect(screen.queryByRole('button', { name: ACTION })).not.toBeInTheDocument();
  });

  it('opens the capture dialog at 10 seconds and says what the capture costs', async () => {
    renderAction();

    await openDialog();

    expect(screen.getByLabelText('Duration')).toHaveValue(10);
    expect(listConnectionNodes).toHaveBeenCalledWith('conn-1');
    expect(
      screen.getByText(/MONITOR adds load to a primary that is already hot \(10\.0\.0\.1:6379\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/estimate below is read from the node this connection points at/),
    ).toBeInTheDocument();
  });

  it('starts the capture on the hot primary and opens its session', async () => {
    renderAction();

    fireEvent.click(await openDialog());

    expect(await screen.findByText('session sess-9')).toBeInTheDocument();
    expect(startSession).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      durationMs: 10_000,
      requestedBy: undefined,
      targetNodeId: 'a0000000',
      fanOut: undefined,
    });
  });

  it('still sends the hot primary when the node list cannot be read', async () => {
    listConnectionNodes.mockRejectedValue(new Error('boom'));
    renderAction();

    fireEvent.click(await openDialog());

    await waitFor(() => expect(startSession).toHaveBeenCalled());
    expect(startSession.mock.calls[0][0]).toMatchObject({ targetNodeId: 'a0000000' });
  });

  it('shows the error and stays open when a capture is already running', async () => {
    startSession.mockRejectedValue(
      new ApiError('A capture session is already active on connection conn-1', 409),
    );
    renderAction();

    fireEvent.click(await openDialog());

    expect(
      await screen.findByText('A capture session is already active on connection conn-1'),
    ).toBeInTheDocument();
    expect(screen.getByText('Start MONITOR capture session')).toBeInTheDocument();
    expect(screen.queryByText(/^session /)).not.toBeInTheDocument();
  });

  it.each<[string, ActionProps]>([
    ['a later read finds the keys', { hotShards: [hotShard({ captureAvailable: false })] }],
    ['the hot shard resolves', { event: { ...EVENT, resolved: true }, hotShards: [] }],
    ['the hot shard list cannot be read', { hotShards: null }],
  ])('keeps an open dialog and what was typed in it when %s', async (_case, props) => {
    const update = renderAction();
    const start = await openDialog();
    fireEvent.change(screen.getByLabelText('Duration'), { target: { value: '20' } });

    update(props);

    expect(screen.queryByRole('button', { name: ACTION })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Duration')).toHaveValue(20);
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() => expect(startSession).toHaveBeenCalled());
    expect(startSession.mock.calls[0][0]).toMatchObject({
      durationMs: 20_000,
      targetNodeId: 'a0000000',
    });
  });

  it('does not reopen a cancelled dialog when the capture is offered again', async () => {
    const update = renderAction();
    await openDialog();
    update({ hotShards: null });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByText('Start MONITOR capture session')).not.toBeInTheDocument(),
    );
    update({});

    expect(screen.getByRole('button', { name: ACTION })).toBeInTheDocument();
    expect(screen.queryByText('Start MONITOR capture session')).not.toBeInTheDocument();
  });

  it('returns the focus to the action when the dialog is cancelled', async () => {
    renderAction();
    await openDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.getByRole('button', { name: ACTION })).toHaveFocus());
  });
});
