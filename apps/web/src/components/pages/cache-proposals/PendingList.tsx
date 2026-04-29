import { Skeleton } from '@/components/ui/skeleton';
import { usePendingProposals } from '../../../hooks/useCacheProposals';
import { PendingCard } from './PendingCard';

export function PendingList() {
  const { data, isLoading, error } = usePendingProposals();

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-[color:var(--chart-critical)]">
        Failed to load pending proposals: {error.message}
      </p>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        No pending proposals. Agents can propose cache optimizations via the MCP server.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {data.map((proposal) => (
        <PendingCard key={proposal.id} proposal={proposal} />
      ))}
    </div>
  );
}
