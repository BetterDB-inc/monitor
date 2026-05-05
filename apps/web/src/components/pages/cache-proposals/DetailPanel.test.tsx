import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { StoredCacheProposal } from '@betterdb/shared';

const useProposalDetailMock = vi.fn();
vi.mock('../../../hooks/useCacheProposals', () => ({
  useProposalDetail: (...args: unknown[]) => useProposalDetailMock(...args),
}));

import { DetailPanel } from './DetailPanel';

function appliedProposal(): StoredCacheProposal {
  return {
    id: 'p1',
    connection_id: 'c1',
    cache_name: 'faq-cache',
    cache_type: 'semantic_cache',
    proposal_type: 'threshold_adjust',
    proposal_payload: { category: null, current_threshold: 0.1, new_threshold: 0.075 },
    reasoning: 'Recent samples cluster tightly under the current threshold.',
    status: 'applied',
    proposed_by: 'mcp:agent-42',
    proposed_at: Date.now() - 3_600_000,
    reviewed_by: 'alice',
    reviewed_at: Date.now() - 60_000,
    applied_at: Date.now() - 60_000,
    applied_result: { previous_value: 0.1, new_value: 0.075 },
    expires_at: Date.now() + 86_400_000,
  } as StoredCacheProposal;
}

describe('DetailPanel', () => {
  beforeEach(() => {
    useProposalDetailMock.mockReset();
  });

  it('renders cache header, reasoning, payload, apply result, and audit trail', () => {
    useProposalDetailMock.mockReturnValue({
      data: {
        proposal: appliedProposal(),
        audit: [
          {
            id: 'a1',
            proposal_id: 'p1',
            event_type: 'proposed',
            event_at: Date.now() - 3_600_000,
            actor: 'agent-42',
            actor_source: 'mcp',
            event_payload: null,
          },
          {
            id: 'a2',
            proposal_id: 'p1',
            event_type: 'approved',
            event_at: Date.now() - 60_000,
            actor: 'alice',
            actor_source: 'ui',
            event_payload: { reason: null },
          },
        ],
      },
      isLoading: false,
      error: null,
    });

    render(<DetailPanel proposalId="p1" open={true} onOpenChange={() => {}} />);

    expect(screen.getByText('faq-cache')).toBeTruthy();
    expect(screen.getByText(/Recent samples cluster tightly/i)).toBeTruthy();
    expect(screen.getByTestId('apply-result').textContent).toContain('previous_value');
    expect(screen.getByText('proposed')).toBeTruthy();
    expect(screen.getByText('approved')).toBeTruthy();
    // audit row text combining actor and source
    expect(screen.getByText(/agent-42 · mcp/)).toBeTruthy();
    expect(screen.getByText(/alice · ui/)).toBeTruthy();
  });

  it('shows the empty audit message when no events recorded', () => {
    useProposalDetailMock.mockReturnValue({
      data: { proposal: appliedProposal(), audit: [] },
      isLoading: false,
      error: null,
    });

    render(<DetailPanel proposalId="p1" open={true} onOpenChange={() => {}} />);

    expect(screen.getByText(/No audit events recorded/i)).toBeTruthy();
  });

  it('does not render audit / payload sections while data is fetching', () => {
    useProposalDetailMock.mockReturnValue({ data: null, isLoading: true, error: null });

    render(<DetailPanel proposalId="p1" open={true} onOpenChange={() => {}} />);

    expect(screen.queryByText('Audit trail')).toBeNull();
    expect(screen.queryByText('Payload')).toBeNull();
  });

  it('renders an error message when the fetch fails', () => {
    useProposalDetailMock.mockReturnValue({
      data: null,
      isLoading: false,
      error: new Error('proposal not found'),
    });

    render(<DetailPanel proposalId="p1" open={true} onOpenChange={() => {}} />);

    expect(screen.getByText(/Failed to load proposal: proposal not found/i)).toBeTruthy();
  });
});
