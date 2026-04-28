import { useMemo, useState } from 'react';
import type { ProposalStatus, StoredCacheProposal } from '@betterdb/shared';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useHistoryProposals } from '../../../hooks/useCacheProposals';
import { formatTimeAgo } from '../../../lib/formatters';
import { DetailPanel } from './DetailPanel';

const STATUS_OPTIONS: Array<{ value: ProposalStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'approved', label: 'Approved' },
  { value: 'applied', label: 'Applied' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'failed', label: 'Failed' },
  { value: 'expired', label: 'Expired' },
];

function statusVariant(status: ProposalStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'applied') {
    return 'default';
  }
  if (status === 'failed') {
    return 'destructive';
  }
  if (status === 'rejected' || status === 'expired') {
    return 'outline';
  }
  return 'secondary';
}

function proposedValueLabel(proposal: StoredCacheProposal): string {
  if (proposal.proposal_type === 'threshold_adjust') {
    return `threshold=${proposal.proposal_payload.new_threshold}`;
  }
  if (proposal.proposal_type === 'tool_ttl_adjust') {
    return `ttl=${proposal.proposal_payload.new_ttl_seconds}s`;
  }
  if (proposal.cache_type === 'semantic_cache') {
    return `filter=${proposal.proposal_payload.filter_expression}`;
  }
  return `${proposal.proposal_payload.filter_kind}=${proposal.proposal_payload.filter_value}`;
}

function proposalSource(proposal: StoredCacheProposal): string {
  if (proposal.proposed_by?.startsWith('mcp:')) {
    return 'mcp';
  }
  if (proposal.reviewed_by?.startsWith('ui:')) {
    return 'ui';
  }
  return proposal.reviewed_by?.startsWith('mcp:') ? 'mcp' : 'ui';
}

export function HistoryTable() {
  const [statusFilter, setStatusFilter] = useState<ProposalStatus | 'all'>('all');
  const [cacheNameFilter, setCacheNameFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const params = useMemo(() => {
    const trimmedName = cacheNameFilter.trim();
    return {
      status: statusFilter === 'all' ? undefined : statusFilter,
      cacheName: trimmedName.length > 0 ? trimmedName : undefined,
    };
  }, [statusFilter, cacheNameFilter]);

  const { data, isLoading, error } = useHistoryProposals(params);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as ProposalStatus | 'all')}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={cacheNameFilter}
          onChange={(e) => setCacheNameFilter(e.target.value)}
          placeholder="Filter by cache name…"
          className="w-64"
        />
      </div>

      {isLoading && <Skeleton className="h-48 w-full" />}
      {error && (
        <p className="text-sm text-[color:var(--chart-critical)]">
          Failed to load history: {error.message}
        </p>
      )}

      {!isLoading && !error && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Cache</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Proposal type</TableHead>
              <TableHead>Proposed value</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Reviewer</TableHead>
              <TableHead>Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data ?? []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                  No proposals match the current filters.
                </TableCell>
              </TableRow>
            ) : (
              (data ?? []).map((proposal) => (
                <TableRow
                  key={proposal.id}
                  onClick={() => setSelectedId(proposal.id)}
                  className="cursor-pointer hover:bg-muted/40"
                >
                  <TableCell className="text-xs text-muted-foreground">
                    {formatTimeAgo(proposal.proposed_at)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{proposal.cache_name}</TableCell>
                  <TableCell>{proposal.cache_type}</TableCell>
                  <TableCell>{proposal.proposal_type}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {proposedValueLabel(proposal)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(proposal.status)}>{proposal.status}</Badge>
                  </TableCell>
                  <TableCell className="text-xs">{proposal.reviewed_by ?? '—'}</TableCell>
                  <TableCell className="text-xs uppercase">
                    {proposalSource(proposal)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      )}

      <DetailPanel
        proposalId={selectedId}
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedId(null);
          }
        }}
      />
    </div>
  );
}
