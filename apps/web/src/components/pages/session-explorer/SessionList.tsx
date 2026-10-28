import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { SessionListResponse, SessionSummary } from '@betterdb/shared';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Alert, AlertDescription } from '../../ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table';
import { cn, formatBytes } from '../../../lib/utils';
import { displaySessionId, formatIdle, formatTtl } from './format';

type SortKey = 'access' | 'size' | 'ttl';

const PAGE_SIZE = 50;

interface Props {
  data: SessionListResponse;
  oversizeIds: Set<string> | null;
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  pattern?: string;
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
  className,
}: {
  label: string;
  column: SortKey;
  className?: string;
  sort: { key: SortKey; descending: boolean };
  onSort: (key: SortKey) => void;
}) {
  const active = sort.key === column;
  const Icon = sort.descending ? ArrowDown : ArrowUp;
  return (
    <TableHead
      className={className}
      aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : undefined}
    >
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

export function SessionList({ data, oversizeIds, selectedId, onSelect, pattern }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({
    key: 'access',
    descending: DEFAULT_DESCENDING.access,
  });
  const [filter, setFilter] = useState('');
  const [shown, setShown] = useState(PAGE_SIZE);

  const onSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key
        ? { key, descending: !prev.descending }
        : { key, descending: DEFAULT_DESCENDING[key] },
    );

  const sessions = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return data.sessions
      .filter((s) => needle === '' || s.sessionId.toLowerCase().includes(needle))
      .sort((a, b) => comparators[sort.key](a, b, sort.descending));
  }, [data.sessions, sort, filter]);
  const visible = sessions.slice(0, shown);
  const remaining = sessions.length - visible.length;

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
      {data.idleUntracked && (
        <Alert>
          <AlertDescription>
            Last access is unknown because the server uses an LFU eviction policy, which does not
            track idle time.
          </AlertDescription>
        </Alert>
      )}
      {data.sessions.length > 0 && (
        <Input
          type="search"
          aria-label="Filter sessions"
          placeholder="Filter sessions"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setShown(PAGE_SIZE);
          }}
        />
      )}
      {data.sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sessions match this pattern.</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sessions match this filter.</p>
      ) : (
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead>Session</TableHead>
              <TableHead className="w-14">Keys</TableHead>
              <SortHeader
                label="Last access"
                column="access"
                sort={sort}
                onSort={onSort}
                className="w-32"
              />
              <SortHeader label="Size" column="size" sort={sort} onSort={onSort} className="w-24" />
              <SortHeader label="TTL" column="ttl" sort={sort} onSort={onSort} className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((s) => (
              <TableRow
                key={s.sessionId}
                tabIndex={0}
                aria-selected={s.sessionId === selectedId}
                onClick={() => onSelect(s.sessionId)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  onSelect(s.sessionId);
                }}
                data-state={s.sessionId === selectedId ? 'selected' : undefined}
                className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              >
                <TableCell>
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-xs" title={s.sessionId}>
                      {displaySessionId(s.sessionId, pattern)}
                    </span>
                    {oversizeIds?.has(s.sessionId) && <Badge variant="warning">Oversize</Badge>}
                  </div>
                </TableCell>
                <TableCell>{s.keyCount}</TableCell>
                <TableCell>{formatIdle(s.idleSeconds)}</TableCell>
                <TableCell>
                  {s.unmeasuredKeys > 0 ? (
                    <span
                      title={`${s.unmeasuredKeys} ${s.unmeasuredKeys === 1 ? 'key' : 'keys'} could not be measured`}
                    >
                      ≥ {formatBytes(s.memoryBytes)}
                    </span>
                  ) : (
                    formatBytes(s.memoryBytes)
                  )}
                </TableCell>
                <TableCell>{formatTtl(s.ttlMs)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {remaining > 0 && (
        <Button variant="outline" size="sm" onClick={() => setShown((n) => n + PAGE_SIZE)}>
          Show more ({remaining.toLocaleString()} remaining)
        </Button>
      )}
    </div>
  );
}
