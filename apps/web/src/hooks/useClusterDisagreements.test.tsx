import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderHookWithQuery } from '../test/test-utils';
import type { TopologyDisagreementSummary } from '../types/anomaly';

const state = vi.hoisted(() => ({ licensed: true }));
const getTopologyDisagreements = vi.hoisted(() => vi.fn());

vi.mock('./useUpgradePrompt', () => ({ useUpgradePrompt: () => ({ showUpgradePrompt: vi.fn() }) }));
vi.mock('./useLicense', () => ({
  useLicense: () => ({ tier: 'pro', license: null, hasFeature: () => state.licensed }),
}));
vi.mock('../api/metrics', () => ({ metricsApi: { getTopologyDisagreements } }));

import { useClusterDisagreements } from './useClusterDisagreements';

const summary: TopologyDisagreementSummary = {
  status: 'ok',
  sampledAt: 1000,
  coverage: { nodes: 3, asked: 3, answered: 3, complete: true, unanswered: [], unansweredCount: 0 },
  disagreements: [],
  shards: [],
};

describe('useClusterDisagreements', () => {
  beforeEach(() => {
    state.licensed = true;
    getTopologyDisagreements.mockReset().mockResolvedValue(summary);
  });

  it('loads the summary of a cluster connection', async () => {
    const { result } = renderHookWithQuery(() => useClusterDisagreements('c1', true));

    await waitFor(() => expect(result.current.summary).toEqual(summary));
    expect(result.current.licensed).toBe(true);
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
});
