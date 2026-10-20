import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { SessionListResponse, SessionSummary } from '@betterdb/shared';
import { Badge } from '../../ui/badge';
import { Alert, AlertDescription } from '../../ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../ui/table';
import { cn, formatBytes } from '../../../lib/utils';
import { formatIdle, formatTtl } from './format';

type SortKey = 'access' | 'size' | 'ttl';

interface Props {
  data: SessionListResponse;
  oversizeIds: Set<string> | null;
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
}

const DEFAULT_DESCENDING: Record<SortKey, boolean> = { access: false, size: true, ttl: false };

const nullsLast = (a: number | null, b: number | null, descending: boolean): number => {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return descending ? b - a : a - b;
};

const comparators: Record<SortKey, (a: SessionSummary, b: SessionSummary, d: boolean) => number> = {
  access: (a, b, d) => nullsLast(a.idleSeconds, b.idleSeconds, d),
  size: (a, b, d) => (d ? b.memoryBytes - a.memoryBytes : a.memoryBytes - b.memoryBytes),
  ttl: (a, b, d) => nullsLast(a.ttlMs, b.ttlMs, d),
};

function SortHeader({
  label,
  column,
  sort,
  onSort,
}: {
  label: string;
  column: SortKey;
  sort: { key: SortKey; descending: boolean };
  onSort: (key: SortKey) => void;
}) {
  const active = sort.key === column;
  const Icon = sort.descending ? ArrowDown : ArrowUp;
  return (
    <TableHead>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn('inline-flex items-center gap-1', active && 'text-foreground')}
      >
        {label}
        {active && <Icon className="h-3 w-3" aria-hidden />}
      </button>
    </TableHead>
  );
}

export function SessionList({ data, oversizeIds, selectedId, onSelect }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({
    key: 'access',
    descending: DEFAULT_DESCENDING.access,
  });

  const onSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key
        ? { key, descending: !prev.descending }
        : { key, descending: DEFAULT_DESCENDING[key] },
    );

  const sessions = useMemo(
    () => [...data.sessions].sort((a, b) => comparators[sort.key](a, b, sort.descending)),
    [data.sessions, sort],
  );

  return (
    <div className="space-y-3">
      {data.truncated && (
        <Alert>
          <AlertDescription>
            Showing the first 10,000 keys. Narrow the pattern to see every session.
          </AlertDescription>
        </Alert>
      )}
      {data.partial && (
        <Alert variant="destructive">
          <AlertDescription>
            {data.failedNodes} {data.failedNodes === 1 ? 'node' : 'nodes'} did not respond, so this
            list is partial.
          </AlertDescription>
        </Alert>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Session</TableHead>
            <TableHead>Keys</TableHead>
            <SortHeader label="Last access" column="access" sort={sort} onSort={onSort} />
            <SortHeader label="Size" column="size" sort={sort} onSort={onSort} />
            <SortHeader label="TTL" column="ttl" sort={sort} onSort={onSort} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((s) => (
            <TableRow
              key={s.sessionId}
              onClick={() => onSelect(s.sessionId)}
              data-state={s.sessionId === selectedId ? 'selected' : undefined}
              className="cursor-pointer"
            >
              <TableCell className="max-w-xs">
                <span className="break-all font-mono text-xs">{s.sessionId}</span>
                {oversizeIds?.has(s.sessionId) && (
                  <Badge variant="warning" className="ms-2">
                    Oversize
                  </Badge>
                )}
              </TableCell>
              <TableCell>{s.keyCount}</TableCell>
              <TableCell>{formatIdle(s.idleSeconds)}</TableCell>
              <TableCell>{formatBytes(s.memoryBytes)}</TableCell>
              <TableCell>{formatTtl(s.ttlMs)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
