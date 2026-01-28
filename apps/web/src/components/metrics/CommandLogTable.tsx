import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { Badge } from '../ui/badge';
import type { CommandLogEntry, CommandLogType } from '../../types/metrics';

interface PaginationProps {
  page: number;
  pageSize: number;
  hasMore: boolean;
  onPageChange: (page: number) => void;
}

interface Props {
  entries: Record<CommandLogType, CommandLogEntry[]>;
  activeTab?: CommandLogType;
  onTabChange?: (type: CommandLogType) => void;
  pagination?: PaginationProps;
}

export function CommandLogTable({ entries, activeTab = 'slow', onTabChange, pagination }: Props) {

  const formatDuration = (duration: number) => {
    if (duration < 1000) return `${duration}µs`;
    if (duration < 1000000) return `${(duration / 1000).toFixed(2)}ms`;
    return `${(duration / 1000000).toFixed(2)}s`;
  };

  const currentEntries = entries[activeTab] || [];

  return (
    <div>
      <div className="flex items-center gap-4 mb-4">
        <Badge variant="outline">Valkey 8.1+</Badge>
        <Tabs value={activeTab} onValueChange={(value) => onTabChange?.(value as CommandLogType)}>
          <TabsList>
            <TabsTrigger value="slow">
              Slow
            </TabsTrigger>
            <TabsTrigger value="large-request">
              Large Request
            </TabsTrigger>
            <TabsTrigger value="large-reply">
              Large Reply
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[100px]">ID</TableHead>
            <TableHead>Time</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead>Command</TableHead>
            <TableHead>Client</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {currentEntries.map((entry) => (
            <TableRow key={entry.id}>
              <TableCell className="font-mono">{entry.id}</TableCell>
              <TableCell>{new Date(entry.timestamp * 1000).toLocaleString()}</TableCell>
              <TableCell className="font-mono">
                {formatDuration(entry.duration)}
              </TableCell>
              <TableCell className="font-mono text-sm max-w-md truncate">
                {entry.command.join(' ')}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {entry.clientName || entry.clientAddress}
              </TableCell>
            </TableRow>
          ))}
          {currentEntries.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground">
                No command log entries
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {pagination && (
        <div className="flex items-center justify-between mt-4 pt-4 border-t">
          <span className="text-sm text-muted-foreground">
            Page {pagination.page + 1} ({currentEntries.length} entries)
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => pagination.onPageChange(pagination.page - 1)}
              disabled={pagination.page === 0}
              className="px-3 py-1 text-sm rounded border border-input bg-background hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <button
              onClick={() => pagination.onPageChange(pagination.page + 1)}
              disabled={!pagination.hasMore}
              className="px-3 py-1 text-sm rounded border border-input bg-background hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
