import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useProposalDetail } from '../../../hooks/useCacheProposals';
import { formatTimeAgo } from '../../../lib/formatters';

interface Props {
  proposalId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DetailPanel({ proposalId, open, onOpenChange }: Props) {
  const { data, isLoading, error } = useProposalDetail(proposalId);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Proposal details</SheetTitle>
          <SheetDescription>
            Full reasoning, payload, and audit trail for this proposal.
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-6 space-y-5">
          {isLoading && <Skeleton className="h-48 w-full" />}
          {error && (
            <p className="text-sm text-[color:var(--chart-critical)]">
              Failed to load proposal: {error.message}
            </p>
          )}

          {data && (
            <>
              <section className="space-y-1">
                <h3 className="text-sm font-semibold">Cache</h3>
                <p className="text-sm font-mono">{data.proposal.cache_name}</p>
                <p className="text-xs text-muted-foreground">
                  {data.proposal.cache_type} · {data.proposal.proposal_type} ·{' '}
                  {data.proposal.status}
                </p>
              </section>

              {data.proposal.reasoning && (
                <section className="space-y-1">
                  <h3 className="text-sm font-semibold">Reasoning</h3>
                  <p className="text-sm whitespace-pre-wrap">{data.proposal.reasoning}</p>
                </section>
              )}

              <section className="space-y-1">
                <h3 className="text-sm font-semibold">Payload</h3>
                <pre className="font-mono text-xs bg-muted p-3 rounded border border-border whitespace-pre-wrap break-all">
                  {JSON.stringify(data.proposal.proposal_payload, null, 2)}
                </pre>
              </section>

              {data.proposal.applied_result && (
                <section className="space-y-1">
                  <h3 className="text-sm font-semibold">Apply result</h3>
                  <pre
                    className="font-mono text-xs p-3 rounded border border-border whitespace-pre-wrap break-all bg-muted"
                    data-testid="apply-result"
                  >
                    {JSON.stringify(data.proposal.applied_result, null, 2)}
                  </pre>
                </section>
              )}

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Audit trail</h3>
                {data.audit.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No audit events recorded.</p>
                ) : (
                  <ul className="space-y-2">
                    {data.audit.map((entry) => (
                      <li
                        key={entry.id}
                        className="text-xs border border-border rounded px-3 py-2"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{entry.event_type}</span>
                          <span className="text-muted-foreground">
                            {formatTimeAgo(entry.event_at)}
                          </span>
                        </div>
                        <div className="text-muted-foreground mt-0.5">
                          {entry.actor ?? '—'} · {entry.actor_source}
                        </div>
                        {entry.event_payload && (
                          <pre className="mt-1.5 font-mono whitespace-pre-wrap break-all">
                            {JSON.stringify(entry.event_payload, null, 2)}
                          </pre>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
