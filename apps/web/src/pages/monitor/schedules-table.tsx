import type { StoredScheduledCapture } from '@betterdb/shared';
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

interface SchedulesTableProps {
  schedules: StoredScheduledCapture[];
  isLoading: boolean;
  onDelete: (id: string) => void;
  deletingId?: string;
}

export function SchedulesTable({
  schedules,
  isLoading,
  onDelete,
  deletingId,
}: SchedulesTableProps) {
  if (isLoading && schedules.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">Loading schedules…</p>
    );
  }

  if (schedules.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No scheduled captures configured for this connection.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Created</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Cadence</TableHead>
          <TableHead className="text-right">Duration</TableHead>
          <TableHead>Last fired</TableHead>
          <TableHead>Last session</TableHead>
          <TableHead>Last skip</TableHead>
          <TableHead aria-label="Actions" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {schedules.map((s) => {
          return (
            <TableRow key={s.id}>
              <TableCell className="whitespace-nowrap font-mono text-xs">
                {formatTimestamp(s.createdAt)}
              </TableCell>
              <TableCell>
                <Badge variant={s.status === 'enabled' ? 'success' : 'outline'}>
                  {s.status}
                </Badge>
              </TableCell>
              <TableCell className="text-xs">{formatCadence(s)}</TableCell>
              <TableCell className="text-right font-mono text-xs">
                {formatDuration(s.durationMs)}
              </TableCell>
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                {s.lastFiredAt ? formatTimestamp(s.lastFiredAt) : '—'}
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {s.lastFiredSessionId ? s.lastFiredSessionId.slice(0, 8) : '—'}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground" title={s.lastSkipReason}>
                {s.lastSkipReason ?? '—'}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={deletingId === s.id}
                  onClick={() => onDelete(s.id)}
                >
                  {deletingId === s.id ? 'Deleting…' : 'Delete'}
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function formatCadence(s: StoredScheduledCapture): string {
  if (s.cronExpression) {
    return `cron: ${s.cronExpression}`;
  }
  if (s.intervalSeconds) {
    return `every ${formatInterval(s.intervalSeconds)}`;
  }
  return 'unknown';
}

function formatInterval(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${(seconds / 60).toFixed(seconds % 60 === 0 ? 0 : 1)}m`;
  }
  return `${(seconds / 3600).toFixed(seconds % 3600 === 0 ? 0 : 1)}h`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}
