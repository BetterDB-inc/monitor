import { FormEvent, ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityEntry, ActivityQuery, Member, workspaceApi } from '@/api/workspace';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DateRange, DateRangePicker } from '@/components/ui/date-range-picker';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface ActivityTabProps {
  members: Member[];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return 'Failed to load activity';
}

function buildQuery(actor: string, action: string, range: DateRange | undefined): ActivityQuery {
  const query: ActivityQuery = {};
  if (actor.length > 0) {
    query.actor = actor;
  }
  if (action.length > 0) {
    query.action = action;
  }
  if (range !== undefined) {
    query.from = range.from.toISOString();
    query.to = range.to.toISOString();
  }
  return query;
}

function targetLabel(entry: ActivityEntry): string {
  if (entry.target === null) {
    return '-';
  }
  return `${entry.target.type} ${entry.target.id}`;
}

export function ActivityTab({ members }: ActivityTabProps): ReactElement {
  const [actor, setActor] = useState('');
  const [actionInput, setActionInput] = useState('');
  const [action, setAction] = useState('');
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  const [items, setItems] = useState<ActivityEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<number>(0);

  const load = useCallback(
    async (cursor: string | null): Promise<void> => {
      requestId.current += 1;
      const currentRequestId = requestId.current;
      setLoading(true);
      setError(null);
      if (cursor === null) {
        setNextCursor(null);
      }
      try {
        const query = buildQuery(actor, action, range);
        if (cursor !== null) {
          query.cursor = cursor;
        }
        const page = await workspaceApi.getActivity(query);
        if (requestId.current !== currentRequestId) {
          return;
        }
        setItems((current) => {
          if (cursor === null) {
            return page.items;
          }
          return [...current, ...page.items];
        });
        setNextCursor(page.nextCursor);
      } catch (err) {
        if (requestId.current !== currentRequestId) {
          return;
        }
        setError(errorMessage(err));
      } finally {
        if (requestId.current === currentRequestId) {
          setLoading(false);
        }
      }
    },
    [actor, action, range],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const applyAction = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setAction(actionInput.trim());
  };

  return (
    <Card className="p-6 space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <label htmlFor="activity-actor" className="text-sm font-medium">
            Actor
          </label>
          <select
            id="activity-actor"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={actor}
            onChange={(event) => {
              setActor(event.target.value);
            }}
          >
            <option value="">Everyone</option>
            {members.map((member) => {
              return (
                <option key={member.id} value={member.id}>
                  {member.email}
                </option>
              );
            })}
          </select>
        </div>
        <div className="space-y-1">
          <span className="text-sm font-medium">When</span>
          <DateRangePicker value={range} onChange={setRange} />
        </div>
        <form className="space-y-1" onSubmit={applyAction}>
          <label htmlFor="activity-action" className="text-sm font-medium">
            Action
          </label>
          <div className="flex gap-2">
            <Input
              id="activity-action"
              placeholder="e.g. member.invite"
              value={actionInput}
              onChange={(event) => {
                setActionInput(event.target.value);
              }}
            />
            <Button type="submit" variant="outline" size="sm">
              Apply
            </Button>
          </div>
        </form>
      </div>
      {error !== null && (
        <div className="p-3 rounded-md bg-destructive/5 text-destructive border border-destructive/20 text-sm">
          {error}
        </div>
      )}
      {items.length === 0 && loading === false && error === null && (
        <p className="text-muted-foreground text-sm">No activity yet</p>
      )}
      {items.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Connection</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((entry) => {
              return (
                <TableRow key={entry.id}>
                  <TableCell className="text-muted-foreground whitespace-nowrap">
                    {new Date(entry.occurredAt).toLocaleString()}
                  </TableCell>
                  <TableCell>{entry.actor.email}</TableCell>
                  <TableCell className="font-mono text-xs">{entry.action}</TableCell>
                  <TableCell className="text-muted-foreground">{targetLabel(entry)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {entry.connectionId ?? '-'}
                  </TableCell>
                  <TableCell>{entry.statusCode}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {nextCursor !== null && (
        <Button
          type="button"
          variant="outline"
          disabled={loading}
          onClick={() => {
            void load(nextCursor);
          }}
        >
          Load more
        </Button>
      )}
    </Card>
  );
}
