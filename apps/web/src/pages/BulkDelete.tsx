import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Eye, Loader2, Trash2, XCircle } from 'lucide-react';
import {
  bulkDeleteApi,
  type BulkDeleteJob,
  type BulkDeleteRequest,
  type BulkDeleteScope,
} from '../api/bulkDelete';
import { PaymentRequiredError } from '../api/client';
import { useUpgradePrompt } from '../hooks/useUpgradePrompt';
import { usePolling } from '../hooks/usePolling';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** True when a pattern would match every key (one or more '*' and nothing else). */
function isCatchAll(pattern: string): boolean {
  return /^\*+$/.test(pattern.trim());
}

/**
 * Whether the dry-run preview card should render. A running preview always
 * shows (its live progress and Cancel must stay reachable even if the target is
 * edited mid-run); a finished preview is hidden once the target has changed.
 */
export function showPreviewCard(
  job: Pick<BulkDeleteJob, 'mode' | 'status'> | null | undefined,
  previewStale: boolean,
): boolean {
  if (job?.mode !== 'dry-run') return false;
  return job.status === 'running' || !previewStale;
}

function statusVariant(status: BulkDeleteJob['status']) {
  switch (status) {
    case 'completed':
      return 'success' as const;
    case 'failed':
      return 'destructive' as const;
    case 'cancelled':
      return 'warning' as const;
    default:
      return 'secondary' as const;
  }
}

function matchedLabel(job: BulkDeleteJob): string {
  return job.truncated ? `${job.matched.toLocaleString()}+` : job.matched.toLocaleString();
}

const numberOrUndefined = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
};

export function BulkDelete() {
  const { showUpgradePrompt } = useUpgradePrompt();

  const [match, setMatch] = useState('');
  const [type, setType] = useState<string>('any');
  const [scope, setScope] = useState<BulkDeleteScope>('node');
  const [count, setCount] = useState('');
  const [batchPauseMs, setBatchPauseMs] = useState('');
  const [maxKeys, setMaxKeys] = useState('');
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);

  // Last completed dry-run job, kept for the confirm dialog's count.
  const [preview, setPreview] = useState<BulkDeleteJob | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [pollEnabled, setPollEnabled] = useState(false);
  // A dry-run reflects the target it ran against; when the target changes the
  // shown preview goes stale until a fresh preview is run.
  const [previewStale, setPreviewStale] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const catchAll = isCatchAll(match);

  // A preview is only valid for the target it was run against; drop the stored
  // preview (confirm dialog) and mark any shown preview stale when the target
  // changes, so neither the card nor the dialog reflects a previous target.
  useEffect(() => {
    setPreview(null);
    setPreviewStale(true);
  }, [match, type, scope, maxKeys]);

  const buildRequest = (): BulkDeleteRequest => ({
    match: match.trim(),
    type: type !== 'any' ? type : undefined,
    scope,
    count: numberOrUndefined(count),
    batchPauseMs: numberOrUndefined(batchPauseMs),
    maxKeys: numberOrUndefined(maxKeys),
    confirmDeleteAll: catchAll ? confirmDeleteAll : undefined,
  });

  const handleGuarded = (err: unknown): string => {
    if (err instanceof PaymentRequiredError) {
      showUpgradePrompt(err);
      return 'This feature requires a Pro or Enterprise license.';
    }
    return err instanceof Error ? err.message : String(err);
  };

  const startJob = (jobId: string) => {
    setActiveJobId(jobId);
    setPollEnabled(true);
    setFormError(null);
  };

  const previewMutation = useMutation({
    mutationFn: () => bulkDeleteApi.preview(buildRequest()),
    onSuccess: ({ jobId }) => {
      setPreviewStale(false);
      startJob(jobId);
    },
    onError: (err) => setFormError(handleGuarded(err)),
  });

  const executeMutation = useMutation({
    mutationFn: () => bulkDeleteApi.execute(buildRequest()),
    onSuccess: ({ jobId }) => {
      startJob(jobId);
      setConfirmOpen(false);
      setConfirmText('');
    },
    onError: (err) => {
      setFormError(handleGuarded(err));
      setConfirmOpen(false);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (jobId: string) => bulkDeleteApi.cancelJob(jobId),
  });

  // Poll the active job while it's running; stop once it reaches a terminal state.
  const { data: job } = usePolling<BulkDeleteJob | null>({
    fetcher: () => (activeJobId ? bulkDeleteApi.getJob(activeJobId) : Promise.resolve(null)),
    interval: 1000,
    enabled: !!activeJobId && pollEnabled,
    refetchKey: activeJobId ?? '',
  });

  // Stop polling once the job finishes; capture a finished dry-run as the
  // preview — but not if the target changed while it ran (then it's stale).
  useEffect(() => {
    if (!job || job.status === 'running') return;
    setPollEnabled(false);
    if (job.mode === 'dry-run' && !previewStale) setPreview(job);
  }, [job, previewStale]);

  const jobRunning = job?.status === 'running';

  const { data: audits } = usePolling({
    fetcher: () => bulkDeleteApi.getAudits(20),
    interval: 15000,
    // Refresh the audit log as soon as a run finishes.
    refetchKey: job && job.status !== 'running' ? job.id + job.status : 'idle',
  });

  const canSubmit = match.trim().length > 0 && (!catchAll || confirmDeleteAll);
  const confirmValid = confirmText.trim().toUpperCase() === 'DELETE';

  const previewCard = job && showPreviewCard(job, previewStale) ? job : null;
  const runCard = job?.mode === 'execute' ? job : null;

  const cancelButton = jobRunning ? (
    <Button
      variant="outline"
      onClick={() => activeJobId && cancelMutation.mutate(activeJobId)}
      disabled={cancelMutation.isPending}
    >
      <XCircle className="size-4" />
      Cancel
    </Button>
  ) : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Bulk Delete by Pattern</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Incrementally delete keys matching a pattern (SCAN&nbsp;+&nbsp;UNLINK). Always preview
          first — deletions are irreversible.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Target</CardTitle>
          <CardDescription>Pattern is passed to SCAN MATCH. Deletes use non-blocking UNLINK.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="bd-match">
                Match pattern <span className="text-destructive">*</span>
              </label>
              <Input
                id="bd-match"
                placeholder="session:*"
                value={match}
                onChange={(e) => setMatch(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="bd-type">
                Type filter
              </label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger id="bd-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any type</SelectItem>
                  <SelectItem value="string">string</SelectItem>
                  <SelectItem value="list">list</SelectItem>
                  <SelectItem value="set">set</SelectItem>
                  <SelectItem value="zset">zset</SelectItem>
                  <SelectItem value="hash">hash</SelectItem>
                  <SelectItem value="stream">stream</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="bd-scope">
                Scope
              </label>
              <Select value={scope} onValueChange={(v) => setScope(v as BulkDeleteScope)}>
                <SelectTrigger id="bd-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="node">This node</SelectItem>
                  <SelectItem value="cluster">All cluster primaries</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="bd-count">
                Batch size (COUNT)
              </label>
              <Input
                id="bd-count"
                type="number"
                min={1}
                placeholder="500"
                value={count}
                onChange={(e) => setCount(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="bd-pause">
                Pause between batches (ms)
              </label>
              <Input
                id="bd-pause"
                type="number"
                min={0}
                placeholder="0"
                value={batchPauseMs}
                onChange={(e) => setBatchPauseMs(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="bd-max">
                Max keys (optional)
              </label>
              <Input
                id="bd-max"
                type="number"
                min={1}
                placeholder="unbounded"
                value={maxKeys}
                onChange={(e) => setMaxKeys(e.target.value)}
              />
            </div>
          </div>

          {catchAll && (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>Catch-all pattern</AlertTitle>
              <AlertDescription>
                <label className="mt-1 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={confirmDeleteAll}
                    onChange={(e) => setConfirmDeleteAll(e.target.checked)}
                  />
                  <span>
                    "{match.trim()}" matches <strong>every key</strong>. Check to confirm you intend
                    to delete the entire keyspace.
                  </span>
                </label>
              </AlertDescription>
            </Alert>
          )}

          {formError && (
            <Alert variant="destructive">
              <XCircle className="size-4" />
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => previewMutation.mutate()}
              disabled={!canSubmit || previewMutation.isPending || jobRunning}
            >
              {previewMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Eye className="size-4" />
              )}
              Preview (dry-run)
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmText('');
                setConfirmOpen(true);
              }}
              disabled={!canSubmit || jobRunning}
            >
              <Trash2 className="size-4" />
              Delete matching keys
            </Button>
          </div>
        </CardContent>
      </Card>

      {previewCard && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Preview
              {previewCard.status === 'running' ? (
                <Badge variant="secondary">
                  <Loader2 className="mr-1 size-3 animate-spin" />
                  scanning… {previewCard.matched.toLocaleString()}
                </Badge>
              ) : (
                <Badge variant="secondary">{matchedLabel(previewCard)} keys</Badge>
              )}
              {previewCard.truncated && <Badge variant="warning">preview capped</Badge>}
            </CardTitle>
            <CardDescription>
              Would delete {matchedLabel(previewCard)} key(s) matching "{previewCard.match}". No keys
              were removed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <SkippedAlert job={previewCard} />
            {previewCard.sampleKeys.length > 0 && (
              <div>
                <p className="text-muted-foreground mb-2 text-xs uppercase tracking-wide">
                  Sample ({previewCard.sampleKeys.length})
                </p>
                <div className="bg-muted/50 max-h-56 overflow-auto rounded-md p-3 font-mono text-xs">
                  {previewCard.sampleKeys.map((key) => (
                    <div key={key} className="truncate">
                      {key}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {cancelButton}
          </CardContent>
        </Card>
      )}

      {runCard && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Run progress
              <Badge variant={statusVariant(runCard.status)}>{runCard.status}</Badge>
              {runCard.truncated && <Badge variant="warning">capped</Badge>}
            </CardTitle>
            <CardDescription>
              Pattern "{runCard.match}" · scope {runCard.scope}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Matched" value={runCard.matched} />
              <Stat label="Deleted" value={runCard.deleted} />
              <Stat label="Batches" value={runCard.batches} />
              <Stat label="Nodes" value={`${runCard.nodesDone}/${runCard.nodesTotal}`} />
            </div>

            {runCard.error && (
              <Alert variant="destructive">
                <XCircle className="size-4" />
                <AlertDescription>{runCard.error}</AlertDescription>
              </Alert>
            )}

            <SkippedAlert job={runCard} />

            {runCard.perNode.length > 1 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-muted-foreground text-left text-xs uppercase">
                    <tr>
                      <th className="py-1 pr-4 font-medium">Node</th>
                      <th className="py-1 pr-4 font-medium">Matched</th>
                      <th className="py-1 pr-4 font-medium">Deleted</th>
                      <th className="py-1 pr-4 font-medium">Batches</th>
                      <th className="py-1 font-medium">Done</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {runCard.perNode.map((n) => (
                      <tr key={n.node} className="border-border/50 border-t">
                        <td className="py-1 pr-4">{n.node}</td>
                        <td className="py-1 pr-4">{n.matched}</td>
                        <td className="py-1 pr-4">{n.deleted}</td>
                        <td className="py-1 pr-4">{n.batches}</td>
                        <td className="py-1">{n.cursorDone ? '✓' : '…'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {cancelButton}
          </CardContent>
        </Card>
      )}

      {audits && audits.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent runs</CardTitle>
            <CardDescription>Audit trail of execute runs on this connection.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-left text-xs uppercase">
                <tr>
                  <th className="py-1 pr-4 font-medium">When</th>
                  <th className="py-1 pr-4 font-medium">Pattern</th>
                  <th className="py-1 pr-4 font-medium">Scope</th>
                  <th className="py-1 pr-4 font-medium">Deleted</th>
                  <th className="py-1 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {audits.map((a) => (
                  <tr key={a.id} className="border-border/50 border-t">
                    <td className="py-1 pr-4 whitespace-nowrap">
                      {new Date(a.timestamp).toLocaleString()}
                    </td>
                    <td className="py-1 pr-4 font-mono">{a.match}</td>
                    <td className="py-1 pr-4">{a.scope}</td>
                    <td className="py-1 pr-4">{a.deleted.toLocaleString()}</td>
                    <td className="flex items-center gap-1 py-1">
                      <Badge variant={statusVariant(a.status)}>{a.status}</Badge>
                      {a.skippedNodes.length > 0 && (
                        <Badge variant="warning">{a.skippedNodes.length} skipped</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm bulk delete</DialogTitle>
            <DialogDescription>
              This will permanently delete keys matching{' '}
              <span className="font-mono font-semibold">{match.trim()}</span>
              {type !== 'any' ? ` of type ${type}` : ''} across{' '}
              {scope === 'cluster' ? 'all cluster primaries' : 'this node'}.
              {preview ? ` Preview matched ${matchedLabel(preview)} key(s).` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="bd-confirm">
              Type <span className="font-mono font-semibold">DELETE</span> to confirm
            </label>
            <Input
              id="bd-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoComplete="off"
              placeholder="DELETE"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => executeMutation.mutate()}
              disabled={!confirmValid || executeMutation.isPending}
            >
              {executeMutation.isPending && <Loader2 className="size-4 animate-spin" />}
              Delete keys
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SkippedAlert({ job }: { job: BulkDeleteJob }) {
  if (job.skipped.length === 0) return null;
  return (
    <Alert className="border-yellow-500/50 text-yellow-700 dark:text-yellow-500">
      <AlertTriangle className="size-4" />
      <AlertTitle>{job.skipped.length} primary node(s) skipped</AlertTitle>
      <AlertDescription>
        <ul className="mt-1 space-y-0.5">
          {job.skipped.map((s) => (
            <li key={s.node} className="font-mono text-xs">
              {s.node} — {s.error}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-muted/40 rounded-md p-3">
      <div className="text-muted-foreground text-xs uppercase tracking-wide">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  );
}
