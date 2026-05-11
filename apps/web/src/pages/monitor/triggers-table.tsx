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
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No capture triggers configured for this connection.
      </p>
    );
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
