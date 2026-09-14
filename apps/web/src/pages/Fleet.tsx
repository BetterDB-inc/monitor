import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { FleetInstanceSummary, FleetOverallStatus } from '@betterdb/shared';
import { fleetApi } from '../api/fleet';
import { usePolling } from '../hooks/usePolling';
import { useConnection } from '../hooks/useConnection';
import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '../components/ui/table';

type StatusFilter = 'all' | 'up' | 'down' | 'unknown';
type SortKey = 'name' | 'memory' | 'ops';

const OVERALL_BADGE: Record<FleetOverallStatus, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  healthy: 'success',
  degraded: 'warning',
  unhealthy: 'destructive',
  waiting: 'secondary',
};

const ROW_BADGE: Record<FleetInstanceSummary['status'], 'success' | 'destructive' | 'secondary'> = {
  up: 'success',
  down: 'destructive',
  unknown: 'secondary',
};

function formatBytes(value: number | null): string {
  if (value === null) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let num = value / 1024;
  let unit = 0;
  while (num >= 1024 && unit < units.length - 1) {
    num /= 1024;
    unit += 1;
  }
  return `${num.toFixed(1)} ${units[unit]}`;
}

function formatUptime(uptimeSec: number | null): string {
  if (uptimeSec === null) return '—';
  const days = Math.floor(uptimeSec / 86400);
  if (days > 0) return `${days}d ${Math.floor((uptimeSec % 86400) / 3600)}h`;
  const hours = Math.floor(uptimeSec / 3600);
  if (hours > 0) return `${hours}h ${Math.floor((uptimeSec % 3600) / 60)}m`;
  return `${Math.floor(uptimeSec / 60)}m`;
}

export function Fleet() {
  const navigate = useNavigate();
  const { setConnection } = useConnection();
  const { data, error, loading, refresh } = usePolling({
    fetcher: fleetApi.getSummary,
    interval: 15000,
  });

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');

  const instances = useMemo(() => {
    const rows = data?.instances ?? [];
    const query = search.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (statusFilter !== 'all' && row.status !== statusFilter) return false;
      if (query && !`${row.name} ${row.host}:${row.port}`.toLowerCase().includes(query)) {
        return false;
      }
      return true;
    });
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case 'memory':
          return (b.memPct ?? -1) - (a.memPct ?? -1);
        case 'ops':
          return (b.opsPerSec ?? -1) - (a.opsPerSec ?? -1);
        case 'name':
        default:
          return a.name.localeCompare(b.name);
      }
    });
  }, [data, statusFilter, search, sortKey]);

  const handleSelect = (connectionId: string) => {
    setConnection(connectionId);
    navigate('/');
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold">Fleet</h1>
          <Skeleton className="h-6 w-24" />
        </div>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Fleet</h1>
        <Card className="p-6">
          <p className="text-sm text-destructive mb-4">
            Failed to load fleet summary: {error.message}
          </p>
          <button
            onClick={() => refresh()}
            className="px-4 py-2 text-sm border rounded-md hover:bg-muted"
          >
            Retry
          </button>
        </Card>
      </div>
    );
  }

  const overallStatus: FleetOverallStatus = data?.overallStatus ?? 'waiting';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Fleet</h1>
        <Badge variant={OVERALL_BADGE[overallStatus]}>{overallStatus}</Badge>
      </div>

      {error && (
        <p className="text-xs text-muted-foreground">
          Last update failed, retrying…{' '}
          <button onClick={() => refresh()} className="underline hover:text-foreground">
            Retry now
          </button>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or host…"
          className="px-3 py-2 border rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary min-w-52"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="px-3 py-2 border rounded-md bg-background text-sm"
          aria-label="Filter by status"
        >
          <option value="all">All statuses</option>
          <option value="up">Up</option>
          <option value="down">Down</option>
          <option value="unknown">Unknown</option>
        </select>
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="px-3 py-2 border rounded-md bg-background text-sm"
          aria-label="Sort by"
        >
          <option value="name">Sort: name</option>
          <option value="memory">Sort: memory %</option>
          <option value="ops">Sort: ops/sec</option>
        </select>
      </div>

      {instances.length === 0 ? (
        <Card className="p-6">
          <p className="text-sm text-muted-foreground">
            {search.trim() || statusFilter !== 'all'
              ? 'No instances match the current filter.'
              : 'No instances to show yet.'}
          </p>
        </Card>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Instance</TableHead>
              <TableHead>Memory</TableHead>
              <TableHead>Ops/sec</TableHead>
              <TableHead>Clients</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Uptime</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {instances.map((row) => (
              <TableRow
                key={row.connectionId}
                onClick={() => handleSelect(row.connectionId)}
                className="cursor-pointer hover:bg-muted/50"
                title={`Open ${row.name} in Dashboard`}
              >
                <TableCell>
                  <span className="flex items-center gap-2">
                    <span
                      className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        row.status === 'up'
                          ? 'bg-green-500'
                          : row.status === 'down'
                            ? 'bg-destructive'
                            : 'bg-gray-400'
                      }`}
                    />
                    <Badge variant={ROW_BADGE[row.status]}>{row.status}</Badge>
                  </span>
                </TableCell>
                <TableCell>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelect(row.connectionId);
                    }}
                    className="font-medium text-left cursor-pointer hover:underline"
                    aria-label={`Open ${row.name} in Dashboard`}
                    title={`Open ${row.name} in Dashboard`}
                  >
                    {row.name}
                  </button>
                  <div className="text-xs text-muted-foreground">
                    {row.host}:{row.port}
                  </div>
                  {row.error && (
                    <div className="text-xs text-destructive truncate max-w-56">{row.error}</div>
                  )}
                </TableCell>
                <TableCell>
                  {row.memPct !== null ? (
                    <span className="flex items-center gap-2">
                      <span className="w-16 h-2 rounded-full bg-muted overflow-hidden">
                        <span
                          className="h-full rounded-full bg-primary block"
                          style={{ width: `${Math.min(100, row.memPct)}%` }}
                        />
                      </span>
                      <span className="text-xs">{row.memPct.toFixed(1)}%</span>
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {formatBytes(row.memoryUsedBytes)}
                    </span>
                  )}
                </TableCell>
                <TableCell>{row.opsPerSec?.toLocaleString() ?? '—'}</TableCell>
                <TableCell>{row.connectedClients ?? '—'}</TableCell>
                <TableCell>{row.replicationRole ?? '—'}</TableCell>
                <TableCell>{formatUptime(row.uptimeSec)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
