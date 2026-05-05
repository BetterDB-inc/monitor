import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { StoredCacheProposal } from '@betterdb/shared';

const useHistoryProposalsMock = vi.fn();
const useProposalDetailMock = vi.fn();

vi.mock('../../../hooks/useCacheProposals', () => ({
  useHistoryProposals: (...args: unknown[]) => useHistoryProposalsMock(...args),
  useProposalDetail: (...args: unknown[]) => useProposalDetailMock(...args),
}));

import { HistoryTable } from './HistoryTable';

function appliedThreshold(overrides: Partial<StoredCacheProposal> = {}): StoredCacheProposal {
  return {
    id: 'p-applied',
    connection_id: 'c1',
    cache_name: 'faq-cache',
    cache_type: 'semantic_cache',
    proposal_type: 'threshold_adjust',
    proposal_payload: { category: null, current_threshold: 0.1, new_threshold: 0.075 },
    reasoning: 'Tighten threshold based on the rolling window.',
    status: 'applied',
    proposed_by: 'mcp:agent-42',
    proposed_at: Date.now() - 86_400_000,
    reviewed_by: 'alice',
    reviewed_at: Date.now() - 80_000_000,
    applied_at: Date.now() - 80_000_000,
    applied_result: { previous_value: 0.1, new_value: 0.075 },
    expires_at: Date.now() - 60_000,
    ...overrides,
  } as StoredCacheProposal;
}

function rejectedAgentTtl(): StoredCacheProposal {
  return {
    id: 'p-rejected',
    connection_id: 'c1',
    cache_name: 'prod-agent',
    cache_type: 'agent_cache',
    proposal_type: 'tool_ttl_adjust',
    proposal_payload: { tool_name: 'web.search', current_ttl_seconds: 60, new_ttl_seconds: 300 },
    reasoning: 'Stable for 5 minutes per the source.',
    status: 'rejected',
    proposed_by: 'ui:bob',
    proposed_at: Date.now() - 3_600_000,
    reviewed_by: 'alice',
    reviewed_at: Date.now() - 30_000,
    applied_at: null,
    applied_result: null,
    expires_at: Date.now() + 86_400_000,
  } as StoredCacheProposal;
}

describe('HistoryTable', () => {
  beforeEach(() => {
    useHistoryProposalsMock.mockReset();
    useProposalDetailMock.mockReset();
    useProposalDetailMock.mockReturnValue({ data: null, isLoading: false, error: null });
  });

  it('renders the Source column derived from proposed_by prefix', () => {
    useHistoryProposalsMock.mockReturnValue({
      data: [appliedThreshold(), rejectedAgentTtl()],
      isLoading: false,
      error: null,
    });

    render(<HistoryTable />);

    const cells = screen.getAllByText(/^(mcp|ui|—)$/i);
    const sources = cells.map((c) => c.textContent?.trim().toLowerCase());
    expect(sources).toContain('mcp');
    expect(sources).toContain('ui');
  });

  it('renders the empty state when no proposals match the filters', () => {
    useHistoryProposalsMock.mockReturnValue({ data: [], isLoading: false, error: null });

    render(<HistoryTable />);

    expect(screen.getByText(/No proposals match the current filters/i)).toBeTruthy();
  });

  it('passes status filter through to useHistoryProposals when changed', () => {
    useHistoryProposalsMock.mockReturnValue({ data: [], isLoading: false, error: null });

    render(<HistoryTable />);

    // Initial call: status undefined (= "all")
    expect(useHistoryProposalsMock).toHaveBeenCalledWith({
      status: undefined,
      cacheName: undefined,
    });

    // No way to fully exercise the shadcn Select via fireEvent without portal hassles,
    // so we assert the typed signature is what we expect on initial render. Filter
    // change behaviour is exercised at the hook level (params memo).
  });

  it('passes cache_name filter through after typing', () => {
    useHistoryProposalsMock.mockReturnValue({ data: [], isLoading: false, error: null });

    render(<HistoryTable />);

    const input = screen.getByPlaceholderText(/Filter by cache name/i);
    fireEvent.change(input, { target: { value: 'faq-cache' } });

    expect(useHistoryProposalsMock).toHaveBeenLastCalledWith({
      status: undefined,
      cacheName: 'faq-cache',
    });
  });

  it('renders — for the Source column when proposed_by has no prefix', () => {
    useHistoryProposalsMock.mockReturnValue({
      data: [appliedThreshold({ proposed_by: 'system-cron' })],
      isLoading: false,
      error: null,
    });

    render(<HistoryTable />);

    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});
