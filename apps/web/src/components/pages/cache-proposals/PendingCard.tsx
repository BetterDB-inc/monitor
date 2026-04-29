import { useState } from 'react';
import type { StoredCacheProposal } from '@betterdb/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  useApproveProposal,
  useEditAndApproveProposal,
  useRejectProposal,
} from '../../../hooks/useCacheProposals';
import { formatExpiresIn, formatTimeAgo } from '../../../lib/formatters';
import { SemanticThresholdBody } from './card-bodies/SemanticThresholdBody';
import { AgentTtlBody } from './card-bodies/AgentTtlBody';
import { SemanticInvalidateBody } from './card-bodies/SemanticInvalidateBody';
import { AgentInvalidateBody } from './card-bodies/AgentInvalidateBody';

interface Props {
  proposal: StoredCacheProposal;
}

type Mode = 'idle' | 'editing' | 'rejecting';

function isInvalidate(proposal: StoredCacheProposal): boolean {
  return proposal.proposal_type === 'invalidate';
}

function renderBody(proposal: StoredCacheProposal, editedValue?: number) {
  if (proposal.cache_type === 'semantic_cache' && proposal.proposal_type === 'threshold_adjust') {
    const payload =
      editedValue !== undefined
        ? { ...proposal.proposal_payload, new_threshold: editedValue }
        : proposal.proposal_payload;
    return <SemanticThresholdBody payload={payload} />;
  }
  if (proposal.cache_type === 'agent_cache' && proposal.proposal_type === 'tool_ttl_adjust') {
    const payload =
      editedValue !== undefined
        ? { ...proposal.proposal_payload, new_ttl_seconds: editedValue }
        : proposal.proposal_payload;
    return <AgentTtlBody payload={payload} />;
  }
  if (proposal.cache_type === 'semantic_cache' && proposal.proposal_type === 'invalidate') {
    return <SemanticInvalidateBody payload={proposal.proposal_payload} />;
  }
  if (proposal.cache_type === 'agent_cache' && proposal.proposal_type === 'invalidate') {
    return <AgentInvalidateBody payload={proposal.proposal_payload} />;
  }
  return null;
}

function defaultEditValue(proposal: StoredCacheProposal): number | null {
  if (proposal.proposal_type === 'threshold_adjust') {
    return proposal.proposal_payload.new_threshold;
  }
  if (proposal.proposal_type === 'tool_ttl_adjust') {
    return proposal.proposal_payload.new_ttl_seconds;
  }
  return null;
}

export function PendingCard({ proposal }: Props) {
  const [mode, setMode] = useState<Mode>('idle');
  const [editValue, setEditValue] = useState<string>(() => {
    const initial = defaultEditValue(proposal);
    return initial !== null ? String(initial) : '';
  });
  const [reason, setReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const approve = useApproveProposal();
  const reject = useRejectProposal();
  const editAndApprove = useEditAndApproveProposal();

  const isMutating = approve.isPending || reject.isPending || editAndApprove.isPending;
  const editHidden = isInvalidate(proposal);

  const onApprove = async () => {
    setActionError(null);
    if (mode === 'editing') {
      const parsed = Number(editValue);
      if (!Number.isFinite(parsed)) {
        setActionError('Edited value must be a number');
        return;
      }
      const body =
        proposal.proposal_type === 'threshold_adjust'
          ? { new_threshold: parsed }
          : { new_ttl_seconds: parsed };
      try {
        await editAndApprove.mutateAsync({ id: proposal.id, body });
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Failed to apply edit');
      }
      return;
    }
    try {
      await approve.mutateAsync({ id: proposal.id });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to approve');
    }
  };

  const onReject = async () => {
    setActionError(null);
    try {
      await reject.mutateAsync({
        id: proposal.id,
        reason: reason.trim().length > 0 ? reason.trim() : null,
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to reject');
    }
  };

  const editedNumber = mode === 'editing' && editValue !== '' ? Number(editValue) : undefined;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-semibold">{proposal.cache_name}</span>
            <Badge variant="outline">{proposal.cache_type}</Badge>
            <Badge variant="secondary">{proposal.proposal_type}</Badge>
          </div>
          <span className="text-xs text-muted-foreground">
            {formatTimeAgo(proposal.proposed_at)}
          </span>
        </div>

        {proposal.reasoning && (
          <p className="text-sm text-muted-foreground line-clamp-3">
            <span className="font-medium text-foreground">Agent reasoning:</span>{' '}
            {proposal.reasoning}
          </p>
        )}

        {renderBody(proposal, Number.isFinite(editedNumber as number) ? editedNumber : undefined)}

        {mode === 'editing' && !editHidden && (
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground">
              {proposal.proposal_type === 'threshold_adjust' ? 'New threshold' : 'New TTL (s)'}
            </label>
            <Input
              type="number"
              step={proposal.proposal_type === 'threshold_adjust' ? '0.001' : '1'}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              className="h-8 w-32"
              data-testid="edit-input"
            />
          </div>
        )}

        {mode === 'rejecting' && (
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground" htmlFor={`reason-${proposal.id}`}>
              Reason (optional)
            </label>
            <Input
              id={`reason-${proposal.id}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you rejecting?"
              data-testid="reject-reason-input"
            />
          </div>
        )}

        {actionError && (
          <p
            className="text-xs text-[color:var(--chart-critical)]"
            data-testid="action-error"
          >
            {actionError}
          </p>
        )}

        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-muted-foreground">
            {formatExpiresIn(proposal.expires_at)}
          </span>
          <div className="flex items-center gap-2">
            {mode === 'rejecting' ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setMode('idle')}
                  disabled={isMutating}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={onReject}
                  disabled={isMutating}
                >
                  {reject.isPending ? 'Rejecting…' : 'Confirm reject'}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setMode('rejecting')}
                  disabled={isMutating}
                >
                  Reject
                </Button>
                {!editHidden && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setMode((m) => (m === 'editing' ? 'idle' : 'editing'))}
                    disabled={isMutating}
                  >
                    {mode === 'editing' ? 'Cancel edit' : 'Edit'}
                  </Button>
                )}
                <Button size="sm" onClick={onApprove} disabled={isMutating}>
                  {approve.isPending || editAndApprove.isPending ? 'Applying…' : 'Approve'}
                </Button>
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
