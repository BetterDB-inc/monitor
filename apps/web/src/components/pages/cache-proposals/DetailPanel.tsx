import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useProposalDetail } from '../../../hooks/useCacheProposals';
import { formatTimeAgo } from '../../../lib/formatters';

interface OutcomeEvaluation {
  verdict: 'improved' | 'degraded' | 'neutral';
  evaluated_at: number;
  window_ms: number;
  signal: string;
  before: Record<string, number>;
  after: Record<string, number>;
  detail: string;
}

function getOutcomeEvaluation(appliedResult: unknown): OutcomeEvaluation | null {
  const details = (appliedResult as { details?: Record<string, unknown> } | null)?.details;
  return (details?.outcome_evaluation as OutcomeEvaluation) ?? null;
}

function verdictVariant(verdict: string): 'default' | 'destructive' | 'outline' {
  if (verdict === 'improved') return 'default';
  if (verdict === 'degraded') return 'destructive';
  return 'outline';
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

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
                <>
                  {(() => {
                    const outcome = getOutcomeEvaluation(data.proposal.applied_result);
                    if (!outcome) return null;
                    return (
                      <section className="space-y-2" data-testid="outcome-evaluation">
                        <h3 className="text-sm font-semibold">Outcome evaluation</h3>
                        <div className="flex items-center gap-2">
                          <Badge variant={verdictVariant(outcome.verdict)}>
                            {outcome.verdict}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            evaluated {formatTimeAgo(outcome.evaluated_at)} ·
                            signal: {outcome.signal} ·
                            window: {Math.round(outcome.window_ms / 1000)}s
                          </span>
                        </div>
                        <p className="text-sm">{outcome.detail}</p>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="rounded border border-border p-2">
                            <p className="text-xs font-medium text-muted-foreground mb-1">Before</p>
                            {Object.entries(outcome.before).map(([k, v]) => (
                              <div key={k} className="flex justify-between text-xs font-mono">
                                <span>{k}</span>
                                <span>{fmtPct(v)}</span>
                              </div>
                            ))}
                          </div>
                          <div className="rounded border border-border p-2">
                            <p className="text-xs font-medium text-muted-foreground mb-1">After</p>
                            {Object.entries(outcome.after).map(([k, v]) => (
                              <div key={k} className="flex justify-between text-xs font-mono">
                                <span>{k}</span>
                                <span>{fmtPct(v)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </section>
                    );
                  })()}
                  <section className="space-y-1">
                    <h3 className="text-sm font-semibold">Apply result</h3>
                    <pre
                      className="font-mono text-xs p-3 rounded border border-border whitespace-pre-wrap break-all bg-muted"
                      data-testid="apply-result"
                    >
                      {JSON.stringify(data.proposal.applied_result, null, 2)}
                    </pre>
                  </section>
                </>
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
