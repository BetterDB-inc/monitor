import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import { renderHookWithQuery } from '../test/test-utils';
import type { TopologyDisagreementSummary, TopologyFullCheck } from '../types/anomaly';

const state = vi.hoisted(() => ({
  licensed: true,
  license: { tier: 'pro' } as { tier: string } | null,
  loading: false,
}));
const getTopologyDisagreements = vi.hoisted(() => vi.fn());
const startTopologyFullCheck = vi.hoisted(() => vi.fn());

vi.mock('./useUpgradePrompt', () => ({ useUpgradePrompt: () => ({ showUpgradePrompt: vi.fn() }) }));
vi.mock('./useLicense', () => ({
  useLicense: () => ({ tier: 'pro', license: state.license, hasFeature: () => state.licensed }),
  useLicenseStatus: () => ({ license: state.license, loading: state.loading, error: null }),
}));
vi.mock('../api/metrics', () => ({
  metricsApi: { getTopologyDisagreements, startTopologyFullCheck },
}));

import { disagreementsPollInterval, useClusterDisagreements } from './useClusterDisagreements';

const summary: TopologyDisagreementSummary = {
  status: 'ok',
  sampledAt: 1000,
  coverage: { nodes: 3, asked: 3, answered: 3, complete: true, unanswered: [], unansweredCount: 0 },
  disagreements: [],
  shards: [],
};

const running: TopologyFullCheck = {
  state: 'running',
  unavailable: null,
  startedAt: 2000,
  finishedAt: null,
  asked: 0,
  total: 500,
  retryAt: null,
  lastFailure: null,
};

describe('useClusterDisagreements', () => {
  beforeEach(() => {
    state.licensed = true;
    state.license = { tier: 'pro' };
    state.loading = false;
    getTopologyDisagreements.mockReset().mockResolvedValue(summary);
    startTopologyFullCheck.mockReset().mockResolvedValue(running);
  });

  it('loads the summary of a cluster connection', async () => {
    const { result } = renderHookWithQuery(() => useClusterDisagreements('c1', true));

    await waitFor(() => expect(result.current.summary).toEqual(summary));
    expect(result.current.licensed).toBe(true);
    expect(result.current.licenseLoading).toBe(false);
  });

  it('asks with the id of the connection it was given', async () => {
    renderHookWithQuery(() => useClusterDisagreements('c7', true));

    await waitFor(() => expect(getTopologyDisagreements).toHaveBeenCalled());
    expect(getTopologyDisagreements.mock.calls[0][0]).toBe('c7');
  });

  it('says the licence is still loading instead of that it is missing', () => {
    state.licensed = false;
    state.license = null;
    state.loading = true;

    const { result } = renderHookWithQuery(() => useClusterDisagreements('c1', true));

    expect(result.current).toMatchObject({ licensed: false, licenseLoading: true });
  });

  it('stops waiting when the licence could not be loaded', () => {
    state.licensed = false;
    state.license = null;
    state.loading = false;

    const { result } = renderHookWithQuery(() => useClusterDisagreements('c1', true));

    expect(result.current).toMatchObject({ licensed: false, licenseLoading: false });
  });

  it('asks for nothing without the anomaly detection licence', async () => {
    state.licensed = false;

    const { result } = renderHookWithQuery(() => useClusterDisagreements('c1', true));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getTopologyDisagreements).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ licensed: false, summary: undefined, error: null });
  });

  it('asks for nothing while the connection is not a cluster', async () => {
    renderHookWithQuery(() => useClusterDisagreements('c1', false));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getTopologyDisagreements).not.toHaveBeenCalled();
  });

  it('hands on the error when the summary cannot be loaded', async () => {
    getTopologyDisagreements.mockRejectedValue(new Error('boom'));

    const { result } = renderHookWithQuery(() => useClusterDisagreements('c1', true));

    await waitFor(() => expect(result.current.error?.message).toBe('boom'), { timeout: 4000 });
    expect(result.current.summary).toBeUndefined();
  });

  it('starts a full check and reads the answer again', async () => {
    const { result } = renderHookWithQuery(() => useClusterDisagreements('c1', true));
    await waitFor(() => expect(result.current.summary).toEqual(summary));
    getTopologyDisagreements.mockResolvedValue({ ...summary, fullCheck: running });

    act(() => result.current.askEveryNode());

    await waitFor(() => expect(result.current.summary?.fullCheck).toEqual(running));
    expect(startTopologyFullCheck).toHaveBeenCalledTimes(1);
    expect(startTopologyFullCheck).toHaveBeenCalledWith('c1');
    await waitFor(() => expect(result.current.asking).toBe(false));
    expect(result.current.askError).toBeNull();
  });

  it('hands on why a full check was refused', async () => {
    startTopologyFullCheck.mockRejectedValue(
      new Error('The last full check finished less than 30 seconds ago'),
    );
    const { result } = renderHookWithQuery(() => useClusterDisagreements('c1', true));
    await waitFor(() => expect(result.current.summary).toEqual(summary));

    act(() => result.current.askEveryNode());

    await waitFor(() =>
      expect(result.current.askError?.message).toBe(
        'The last full check finished less than 30 seconds ago',
      ),
    );
    expect(result.current.asking).toBe(false);
  });

  it('forgets a refusal when the connection changes', async () => {
    startTopologyFullCheck.mockRejectedValue(new Error('refused'));
    let connectionId = 'c1';
    const { result, rerender } = renderHookWithQuery(() =>
      useClusterDisagreements(connectionId, true),
    );
    await waitFor(() => expect(result.current.summary).toEqual(summary));
    act(() => result.current.askEveryNode());
    await waitFor(() => expect(result.current.askError).not.toBeNull());

    connectionId = 'c2';
    rerender();

    await waitFor(() => expect(result.current.askError).toBeNull());
  });

  it('reads more often while a full check runs', () => {
    expect(disagreementsPollInterval({ ...summary, fullCheck: running })).toBe(2000);
    expect(
      disagreementsPollInterval({ ...summary, fullCheck: { ...running, state: 'done' } }),
    ).toBe(5000);
    expect(disagreementsPollInterval(summary)).toBe(5000);
    expect(disagreementsPollInterval(undefined)).toBe(5000);
  });
});
