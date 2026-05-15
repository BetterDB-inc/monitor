import { Link } from 'react-router-dom';
import type { CaptureTriggerStatus, StoredCaptureTrigger } from '@betterdb/shared';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';

interface TriggersTableProps {
  triggers: StoredCaptureTrigger[];
  isLoading: boolean;
  onCancel: (id: string) => void;
  cancellingId?: string;
}

const ACTIVE_STATUSES: CaptureTriggerStatus[] = ['configured', 'queued'];

export function TriggersTable({
  triggers,
  isLoading,
  onCancel,
  cancellingId,
}: TriggersTableProps) {
  if (isLoading && triggers.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">Loading triggers…</p>
    );
  }

  if (triggers.length === 0) {
    return <TriggersEmptyState />;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Created</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Source anomaly</TableHead>
          <TableHead>Expires</TableHead>
          <TableHead>Fired session</TableHead>
          <TableHead>Created by</TableHead>
          <TableHead aria-label="Actions" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {triggers.map((t) => {
          const cancellable = ACTIVE_STATUSES.includes(t.status);
          return (
            <TableRow key={t.id}>
              <TableCell className="whitespace-nowrap font-mono text-xs">
                {formatTimestamp(t.createdAt)}
              </TableCell>
              <TableCell>
                <TriggerStatusBadge status={t.status} skipReason={t.skipReason} />
              </TableCell>
              <TableCell className="text-xs">
                <span className="font-medium">{t.metricType}</span>{' '}
                <span className="text-muted-foreground">/ {t.anomalyType}</span>
              </TableCell>
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                {formatRelative(t.expiresAt)}
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {t.firedSessionId
                  ? t.firedSessionId.slice(0, 8)
                  : '—'}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {t.createdBy ?? '—'}
              </TableCell>
              <TableCell className="text-right">
                {cancellable ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={cancellingId === t.id}
                    onClick={() => onCancel(t.id)}
                  >
                    {cancellingId === t.id ? 'Cancelling…' : 'Delete'}
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function TriggerStatusBadge({
  status,
  skipReason,
}: {
  status: CaptureTriggerStatus;
  skipReason?: string;
}) {
  const title = status === 'skipped' && skipReason ? `Skipped: ${skipReason}` : undefined;
  return (
    <Badge variant={variantFor(status)} title={title}>
      {status}
    </Badge>
  );
}

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';

function variantFor(status: CaptureTriggerStatus): BadgeVariant {
  if (status === 'fired') {
    return 'success';
  }
  if (status === 'configured') {
    return 'secondary';
  }
  if (status === 'queued') {
    return 'warning';
  }
  if (status === 'skipped') {
    return 'destructive';
  }
  return 'outline';
}

function TriggersEmptyState() {
  return (
    <div className="py-10 px-4">
      <p className="mb-8 text-center text-sm text-muted-foreground">
        No capture triggers configured. Set one up from the Anomaly Detection page:
      </p>

      <div className="mx-auto flex max-w-3xl items-start gap-3">
        {/* Step 1 */}
        <div className="flex flex-1 flex-col items-center gap-3">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-emerald-500/40 bg-emerald-950/30 text-xs font-bold text-emerald-400">
            1
          </div>
          <div className="text-[10px] font-semibold uppercase tracking-widest text-emerald-500">
            Anomaly Detection
          </div>
          {/* Mini UI mockup — clickable */}
          <Link to="/anomalies" className="w-full overflow-hidden rounded-lg border border-border bg-muted/30 transition-colors hover:border-emerald-500/40">
            <div className="border-b border-border px-3 py-2 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
              Correlated Events
            </div>
            <div className="space-y-1.5 p-2.5">
              {/* Dimmed row */}
              <div className="flex items-center gap-2 rounded-md border border-border/50 bg-background/40 px-2.5 py-2 opacity-40">
                <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" />
                <div className="flex-1">
                  <div className="h-2 w-20 rounded bg-muted-foreground/30" />
                </div>
                <div className="h-5 w-5 rounded border border-border" />
              </div>
              {/* Highlighted row */}
              <div className="relative flex items-center gap-2 rounded-md border border-amber-500/60 bg-amber-500/5 px-2.5 py-2">
                <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                <div className="flex-1">
                  <div className="h-2 w-24 rounded bg-amber-400/40" />
                  <div className="mt-1 h-1.5 w-16 rounded bg-muted-foreground/20" />
                </div>
                {/* The button to click */}
                <div className="relative flex h-6 w-6 items-center justify-center rounded-md bg-emerald-400">
                  <svg className="h-3 w-3 text-emerald-950" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 4l4 4-4 4"/></svg>
                  <span className="absolute -bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-emerald-400 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wide text-emerald-950">
                    Click
                  </span>
                </div>
              </div>
              {/* Dimmed row */}
              <div className="flex items-center gap-2 rounded-md border border-border/50 bg-background/40 px-2.5 py-2 opacity-40">
                <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400" />
                <div className="flex-1">
                  <div className="h-2 w-16 rounded bg-muted-foreground/30" />
                </div>
                <div className="h-5 w-5 rounded border border-border" />
              </div>
            </div>
          </Link>
        </div>

        {/* Arrow */}
        <div className="mt-16 flex shrink-0 items-center text-muted-foreground/40">
          <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M7.293 4.293a1 1 0 011.414 0l5 5a1 1 0 010 1.414l-5 5a1 1 0 01-1.414-1.414L11.586 10 7.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/></svg>
        </div>

        {/* Step 2 */}
        <div className="flex flex-1 flex-col items-center gap-3">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-emerald-500/40 bg-emerald-950/30 text-xs font-bold text-emerald-400">
            2
          </div>
          <div className="text-[10px] font-semibold uppercase tracking-widest text-emerald-500">
            Confirm trigger
          </div>
          {/* Mini modal mockup */}
          <div className="w-full overflow-hidden rounded-lg border border-border bg-popover">
            <div className="border-b border-border px-3 py-2.5">
              <div className="text-xs font-semibold text-foreground">Capture on next occurrence</div>
              <div className="mt-1 text-[9px] leading-relaxed text-muted-foreground">
                Schedules a MONITOR capture the next time this anomaly recurs.
              </div>
            </div>
            <div className="px-3 py-2.5">
              <div className="rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-[10px] font-medium text-foreground">
                Capture next spike on Memory.
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-3 py-2">
              <div className="rounded-md border border-border px-2.5 py-1 text-[10px] text-muted-foreground">
                Cancel
              </div>
              <div className="relative rounded-md bg-emerald-400 px-3 py-1 text-[10px] font-bold text-emerald-950">
                Create trigger
              </div>
            </div>
          </div>
        </div>

        {/* Arrow */}
        <div className="mt-16 flex shrink-0 items-center text-muted-foreground/40">
          <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M7.293 4.293a1 1 0 011.414 0l5 5a1 1 0 010 1.414l-5 5a1 1 0 01-1.414-1.414L11.586 10 7.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/></svg>
        </div>

        {/* Step 3 */}
        <div className="flex flex-1 flex-col items-center gap-3">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-cyan-500/40 bg-cyan-950/30 text-xs font-bold text-cyan-400">
            3
          </div>
          <div className="text-[10px] font-semibold uppercase tracking-widest text-cyan-400">
            Trigger active
          </div>
          <div className="w-full overflow-hidden rounded-lg border border-border bg-muted/30">
            <div className="border-b border-border px-3 py-2 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
              Active triggers
            </div>
            <div className="p-2.5">
              <div className="flex items-center gap-2 rounded-md border border-cyan-500/20 bg-cyan-500/5 px-2.5 py-2.5">
                <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-400" />
                <div className="flex-1">
                  <div className="text-[10px] font-semibold text-foreground">memory_used / spike</div>
                  <div className="mt-0.5 text-[9px] text-muted-foreground">Waiting for next anomaly…</div>
                </div>
                <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wide text-cyan-400">
                  configured
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

function formatRelative(ms: number): string {
  const now = Date.now();
  const delta = ms - now;
  if (delta <= 0) {
    return 'expired';
  }
  if (delta < 60_000) {
    return `${Math.round(delta / 1000)}s`;
  }
  if (delta < 3_600_000) {
    return `${Math.round(delta / 60_000)}m`;
  }
  if (delta < 86_400_000) {
    return `${(delta / 3_600_000).toFixed(1)}h`;
  }
  return `${(delta / 86_400_000).toFixed(1)}d`;
}
