import type { StoredCaptureSession } from '@betterdb/shared';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { SessionStatusBadge } from './session-status-badge';

interface SessionsTableProps {
  sessions: StoredCaptureSession[];
  isLoading: boolean;
}

export function SessionsTable({ sessions, isLoading }: SessionsTableProps) {
  if (isLoading && sessions.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">Loading sessions…</p>
    );
  }

  if (sessions.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No capture sessions for this connection yet.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Started</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Source</TableHead>
          <TableHead className="text-right">Duration</TableHead>
          <TableHead className="text-right">Lines</TableHead>
          <TableHead className="text-right">Bytes</TableHead>
          <TableHead>Termination</TableHead>
          <TableHead>Requested by</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sessions.map((s) => (
          <TableRow key={s.id}>
            <TableCell className="whitespace-nowrap font-mono text-xs">
              {formatTimestamp(s.startedAt)}
            </TableCell>
            <TableCell>
              <SessionStatusBadge status={s.status} />
            </TableCell>
            <TableCell className="text-xs uppercase tracking-wide text-muted-foreground">
              {s.source}
            </TableCell>
            <TableCell className="text-right font-mono text-xs">
              {formatDuration(s)}
            </TableCell>
            <TableCell className="text-right font-mono text-xs">
              {s.lineCount.toLocaleString()}
            </TableCell>
            <TableCell className="text-right font-mono text-xs">
              {formatBytes(s.byteCount)}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {s.terminationReason ?? '—'}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {s.requestedBy ?? '—'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

function formatDuration(s: StoredCaptureSession): string {
  if (s.status === 'running') return 'live';
  const ms = s.durationMs ?? (s.endedAt ? s.endedAt - s.startedAt : 0);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}
