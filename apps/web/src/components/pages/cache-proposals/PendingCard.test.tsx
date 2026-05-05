import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { StoredCacheProposal } from '@betterdb/shared';

const approveMutate = vi.fn().mockResolvedValue({});
const rejectMutate = vi.fn().mockResolvedValue({});
const editApproveMutate = vi.fn().mockResolvedValue({});
let approvePending = false;

vi.mock('../../../hooks/useCacheProposals', () => ({
  useApproveProposal: () => ({
    mutateAsync: approveMutate,
    isPending: approvePending,
  }),
  useRejectProposal: () => ({
    mutateAsync: rejectMutate,
    isPending: false,
  }),
  useEditAndApproveProposal: () => ({
    mutateAsync: editApproveMutate,
    isPending: false,
  }),
}));

import { PendingCard } from './PendingCard';

const baseFields = {
  id: 'p1',
  connection_id: 'c1',
  cache_name: 'agent_chat',
  reasoning: 'Recent samples cluster tightly under the current threshold.',
  status: 'pending' as const,
  proposed_by: 'mcp:test',
  proposed_at: Date.now() - 60_000,
  reviewed_by: null,
  reviewed_at: null,
  applied_at: null,
  applied_result: null,
  expires_at: Date.now() + 18 * 3600_000,
};

function semanticThreshold(): StoredCacheProposal {
  return {
    ...baseFields,
    cache_type: 'semantic_cache',
    proposal_type: 'threshold_adjust',
    proposal_payload: {
      category: 'faq',
      current_threshold: 0.1,
      new_threshold: 0.075,
    },
  };
}

function agentTtl(): StoredCacheProposal {
  return {
    ...baseFields,
    cache_type: 'agent_cache',
    proposal_type: 'tool_ttl_adjust',
    proposal_payload: {
      tool_name: 'web.search',
      current_ttl_seconds: 60,
      new_ttl_seconds: 300,
    },
  };
}

function semanticInvalidate(estimated = 5000): StoredCacheProposal {
  return {
    ...baseFields,
    cache_type: 'semantic_cache',
    proposal_type: 'invalidate',
    proposal_payload: {
      filter_kind: 'valkey_search',
      filter_expression: '@model:{gpt-4o}',
      estimated_affected: estimated,
    },
  };
}

function agentInvalidate(): StoredCacheProposal {
  return {
    ...baseFields,
    cache_type: 'agent_cache',
    proposal_type: 'invalidate',
    proposal_payload: {
      filter_kind: 'tool',
      filter_value: 'web.search',
      estimated_affected: 42,
    },
  };
}

describe('PendingCard', () => {
  beforeEach(() => {
    approveMutate.mockClear();
    rejectMutate.mockClear();
    editApproveMutate.mockClear();
    approvePending = false;
  });

  it('renders semantic threshold body with category', () => {
    render(<PendingCard proposal={semanticThreshold()} />);
    expect(screen.getByText(/threshold=0.1/)).toBeInTheDocument();
    expect(screen.getByText(/category 'faq'/)).toBeInTheDocument();
    expect(screen.getByText(/threshold=0.075/)).toBeInTheDocument();
  });

  it('renders agent TTL body with formatted TTL', () => {
    render(<PendingCard proposal={agentTtl()} />);
    expect(screen.getByText(/ttl=1m/)).toBeInTheDocument();
    expect(screen.getByText(/ttl=5m/)).toBeInTheDocument();
  });

  it('renders semantic invalidate body with monospace filter block', () => {
    const { container } = render(<PendingCard proposal={semanticInvalidate()} />);
    expect(container.querySelector('pre')?.textContent).toContain('@model:{gpt-4o}');
  });

  it('renders agent invalidate body with filter_kind label', () => {
    render(<PendingCard proposal={agentInvalidate()} />);
    expect(screen.getByText('Tool:')).toBeInTheDocument();
    expect(screen.getByText('web.search')).toBeInTheDocument();
  });

  it('hides Edit button on invalidate cards', () => {
    render(<PendingCard proposal={semanticInvalidate()} />);
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('triggers warn visual when estimated_affected > 10000', () => {
    render(<PendingCard proposal={semanticInvalidate(15000)} />);
    expect(screen.getByTestId('estimated-affected')).toHaveAttribute('data-warn', 'true');
  });

  it('does not trigger warn visual at 10000 or below', () => {
    render(<PendingCard proposal={semanticInvalidate(10000)} />);
    expect(screen.getByTestId('estimated-affected')).toHaveAttribute('data-warn', 'false');
  });

  it('switches Approve to "Applying…" while pending', () => {
    approvePending = true;
    render(<PendingCard proposal={semanticThreshold()} />);
    expect(screen.getByRole('button', { name: 'Applying…' })).toBeInTheDocument();
  });

  it('opens reject reason input and submits with reason', async () => {
    render(<PendingCard proposal={semanticThreshold()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const input = screen.getByTestId('reject-reason-input');
    fireEvent.change(input, { target: { value: 'too aggressive' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm reject' }));
    await waitFor(() => {
      expect(rejectMutate).toHaveBeenCalledWith({ id: 'p1', reason: 'too aggressive' });
    });
  });

  it('submits null reason when reject reason is empty', async () => {
    render(<PendingCard proposal={semanticThreshold()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm reject' }));
    await waitFor(() => {
      expect(rejectMutate).toHaveBeenCalledWith({ id: 'p1', reason: null });
    });
  });

  it('edits threshold and posts via edit-and-approve', async () => {
    render(<PendingCard proposal={semanticThreshold()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const input = screen.getByTestId('edit-input');
    fireEvent.change(input, { target: { value: '0.05' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(editApproveMutate).toHaveBeenCalledWith({
        id: 'p1',
        body: { new_threshold: 0.05 },
      });
    });
  });

  it('approves directly without edit', async () => {
    render(<PendingCard proposal={agentTtl()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(approveMutate).toHaveBeenCalledWith({ id: 'p1' });
    });
  });
});
