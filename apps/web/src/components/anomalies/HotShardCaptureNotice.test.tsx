import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import type { HotShardDetail } from '../../types/anomaly';

const { getAnomalyEvents, getHotShards, listConnectionNodes, preflight, startSession } = vi.hoisted(
  () => ({
    getAnomalyEvents: vi.fn(),
    getHotShards: vi.fn(),
    listConnectionNodes: vi.fn(),
    preflight: vi.fn(),
    startSession: vi.fn(),
  }),
);

vi.mock('../../api/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/metrics')>();
  return { ...actual, metricsApi: { getAnomalyEvents, getHotShards } };
});
vi.mock('../../api/monitor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/monitor')>();
  return { ...actual, monitorApi: { listConnectionNodes, preflight, startSession } };
});
vi.mock('../../pages/monitor/preflight-panel', () => ({
  PreflightPanel: () => <div>pre-flight report</div>,
}));

import { HotShardCaptureNotice } from './HotShardCaptureNotice';

const EVENT = { id: 'evt-1', metricType: 'hot_shard', resolved: false };
const ACTION = 'Capture on hot primary';
const OPEN_HOT_SHARDS = { metricType: 'hot_shard', activeOnly: true };

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

interface Served {
  events?: unknown[];
  hotShards?: HotShardDetail[] | Error;
}

function serve({ events = [EVENT], hotShards = [hotShard()] }: Served = {}): void {
  getAnomalyEvents.mockResolvedValue(events);
  if (hotShards instanceof Error) getHotShards.mockRejectedValue(hotShards);
  else getHotShards.mockResolvedValue(hotShards);
}

function renderNotice(
  { connectionId }: { connectionId?: string } = { connectionId: 'conn-1' },
): (next: Served) => Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/anomalies']}>
        <Routes>
          <Route
            path="/anomalies"
            element={<HotShardCaptureNotice connectionId={connectionId} />}
          />
          <Route path="/monitor/sessions/:id" element={<SessionPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return async (next) => {
    serve(next);
    await act(() => client.invalidateQueries());
  };
}

async function openDialog(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: ACTION }));
  await screen.findByText('Start MONITOR capture session');
  const start = screen.getByRole('button', { name: 'Start session' });
  await waitFor(() => expect(start).toBeEnabled());
  return start;
}

describe('HotShardCaptureNotice', () => {
  beforeEach(() => {
    getAnomalyEvents.mockReset();
    getHotShards.mockReset();
    serve();
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

  it('asks for the open hot shard events of any age, with no date range', async () => {
    renderNotice();

    await screen.findByRole('button', { name: ACTION });

    expect(getAnomalyEvents).toHaveBeenCalledWith(OPEN_HOT_SHARDS);
    expect(getAnomalyEvents.mock.calls.every(([query]) => query.startTime === undefined)).toBe(
      true,
    );
  });

  it('offers a capture for an open hot shard whose key names are missing, and says why', async () => {
    renderNotice();

    expect(await screen.findByRole('button', { name: ACTION })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Hot shard a0000000 at 10.0.0.1:6379 has no key names: maxmemory-policy is not an ' +
          'LFU policy, so the node keeps no access frequency.',
      ),
    ).toBeInTheDocument();
    expect(listConnectionNodes).not.toHaveBeenCalled();
  });

  it('offers one capture for each open hot shard that has no key names', async () => {
    serve({
      events: [EVENT, { ...EVENT, id: 'evt-2' }, { ...EVENT, id: 'evt-3' }],
      hotShards: [
        hotShard(),
        hotShard({ eventId: 'evt-2', shardId: 'b0000000', nodeAddr: '10.0.0.2:6379' }),
        hotShard({ eventId: 'evt-3', shardId: 'c0000000', captureAvailable: false }),
      ],
    });
    renderNotice();

    expect(await screen.findAllByRole('button', { name: ACTION })).toHaveLength(2);
    expect(screen.getByText(/Hot shard b0000000 at 10\.0\.0\.2:6379/)).toBeInTheDocument();
    expect(screen.queryByText(/Hot shard c0000000/)).not.toBeInTheDocument();
  });

  it.each<[string, unknown[]]>([
    ['no hot shard event is open', []],
    ['the only hot shard event is resolved', [{ ...EVENT, resolved: true }]],
  ])('does not read the hot shard list when %s', async (_case, events) => {
    serve({ events });
    renderNotice();

    await waitFor(() => expect(getAnomalyEvents).toHaveBeenCalledWith(OPEN_HOT_SHARDS));
    await act(async () => undefined);

    expect(getHotShards).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: ACTION })).not.toBeInTheDocument();
  });

  it.each<[string, Served]>([
    ['the hot shard list is empty', { hotShards: [] }],
    ['the hot shard list could not be read', { hotShards: new Error('boom') }],
    ['a capture cannot help', { hotShards: [hotShard({ captureAvailable: false })] }],
  ])('offers nothing when %s', async (_case, served) => {
    serve(served);
    renderNotice();

    await waitFor(() => expect(getHotShards).toHaveBeenCalled());
    await act(async () => undefined);

    expect(screen.queryByRole('button', { name: ACTION })).not.toBeInTheDocument();
  });

  it('asks nothing and offers nothing when no connection is selected', async () => {
    renderNotice({});

    await act(async () => undefined);

    expect(getAnomalyEvents).not.toHaveBeenCalled();
    expect(getHotShards).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: ACTION })).not.toBeInTheDocument();
  });

  it('opens the capture dialog at 10 seconds and says what the capture costs', async () => {
    renderNotice();

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

  it('starts the capture on the hot primary, with no fan-out, and opens its session', async () => {
    renderNotice();

    const start = await openDialog();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Cluster node')).not.toBeInTheDocument();
    fireEvent.click(start);

    expect(await screen.findByText('session sess-9')).toBeInTheDocument();
    expect(startSession).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      durationMs: 10_000,
      requestedBy: undefined,
      targetNodeId: 'a0000000',
      fanOut: undefined,
    });
  });

  it('starts the capture on the shard whose action was used', async () => {
    serve({
      events: [EVENT, { ...EVENT, id: 'evt-2' }],
      hotShards: [
        hotShard(),
        hotShard({ eventId: 'evt-2', shardId: 'b0000000', nodeAddr: '10.0.0.2:6379' }),
      ],
    });
    renderNotice();

    fireEvent.click((await screen.findAllByRole('button', { name: ACTION }))[1]);
    const start = await screen.findByRole('button', { name: 'Start session' });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);

    await waitFor(() => expect(startSession).toHaveBeenCalled());
    expect(startSession.mock.calls[0][0]).toMatchObject({ targetNodeId: 'b0000000' });
  });

  it('still sends the hot primary when the node list cannot be read', async () => {
    listConnectionNodes.mockRejectedValue(new Error('boom'));
    renderNotice();

    fireEvent.click(await openDialog());

    await waitFor(() => expect(startSession).toHaveBeenCalled());
    expect(startSession.mock.calls[0][0]).toMatchObject({ targetNodeId: 'a0000000' });
  });

  it('shows the error and stays open when a capture is already running', async () => {
    startSession.mockRejectedValue(
      new ApiError('A capture session is already active on connection conn-1', 409),
    );
    renderNotice();

    fireEvent.click(await openDialog());

    expect(
      await screen.findByText('A capture session is already active on connection conn-1'),
    ).toBeInTheDocument();
    expect(screen.getByText('Start MONITOR capture session')).toBeInTheDocument();
    expect(screen.queryByText(/^session /)).not.toBeInTheDocument();
  });

  it.each<[string, Served]>([
    ['a later read finds the keys', { hotShards: [hotShard({ captureAvailable: false })] }],
    ['the hot shard resolves', { events: [], hotShards: [] }],
    ['the hot shard list cannot be read', { hotShards: new Error('boom') }],
  ])('keeps an open dialog and what was typed in it when %s', async (_case, served) => {
    const update = renderNotice();
    const start = await openDialog();
    fireEvent.change(screen.getByLabelText('Duration'), { target: { value: '20' } });

    await update(served);

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: ACTION })).not.toBeInTheDocument(),
    );
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
    const update = renderNotice();
    await openDialog();
    await update({ hotShards: [] });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByText('Start MONITOR capture session')).not.toBeInTheDocument(),
    );
    await update({});

    expect(await screen.findByRole('button', { name: ACTION })).toBeInTheDocument();
    expect(screen.queryByText('Start MONITOR capture session')).not.toBeInTheDocument();
  });

  it('returns the focus to the action when the dialog is cancelled', async () => {
    renderNotice();
    await openDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.getByRole('button', { name: ACTION })).toHaveFocus());
  });
});
