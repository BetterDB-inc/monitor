import { useState } from 'react';
import type { Connection } from '../../../hooks/useConnection';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { Input } from '../../ui/input';
import { EngineBadge } from './EngineBadge';
import type { EndpointRole } from './EndpointPanel';

interface Props {
  open: boolean;
  role: EndpointRole;
  connections: Connection[];
  selectedId: string | null;
  excludeId: string | null;
  onSelect: (connection: Connection) => void;
  onOpenChange: (open: boolean) => void;
}

function unavailableReason(
  connection: Connection,
  role: EndpointRole,
  excludeId: string | null,
): string | null {
  if (connection.id === excludeId) {
    return role === 'source' ? 'Already the target' : 'Already the source';
  }
  if (connection.connectionType === 'agent') {
    return 'Agent-backed — contact support';
  }
  if (role === 'target' && connection.isConnected === false) {
    return 'Offline — cannot accept writes';
  }
  return null;
}

function matchesFilter(connection: Connection, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle === '') {
    return true;
  }
  return (
    connection.name.toLowerCase().includes(needle) ||
    connection.host.toLowerCase().includes(needle) ||
    String(connection.port).includes(needle)
  );
}

export function ConnectionPicker({
  open,
  role,
  connections,
  selectedId,
  excludeId,
  onSelect,
  onOpenChange,
}: Props) {
  const [filter, setFilter] = useState('');

  const visible = connections.filter((connection) => {
    return matchesFilter(connection, filter);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Select {role}</DialogTitle>
          <DialogDescription>
            {role === 'source'
              ? 'The instance to copy data from. It is only read during analysis.'
              : 'The instance to copy data into. It must be online and accept writes.'}
          </DialogDescription>
        </DialogHeader>

        <Input
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
          }}
          placeholder="Filter by name or host"
          aria-label="Filter connections"
        />

        <div className="max-h-80 divide-y overflow-y-auto rounded-lg border">
          {visible.length === 0 && (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No connection matches “{filter}”.
            </p>
          )}

          {visible.map((connection) => {
            const reason = unavailableReason(connection, role, excludeId);
            const isSelected = connection.id === selectedId;

            return (
              <button
                key={connection.id}
                type="button"
                disabled={reason !== null}
                aria-current={isSelected}
                onClick={() => {
                  onSelect(connection);
                  onOpenChange(false);
                }}
                className={`flex w-full items-center gap-4 px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  isSelected ? 'bg-muted' : 'enabled:hover:bg-muted/60'
                }`}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {connection.name}
                    <span
                      className={`size-2 rounded-full ${
                        connection.isConnected ? 'bg-success' : 'bg-muted-foreground'
                      }`}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {connection.host}:{connection.port}
                    {connection.connectionType === 'agent' ? ' · via agent' : ' · direct'}
                  </span>
                </span>

                <EngineBadge capabilities={connection.capabilities} />

                {reason !== null && (
                  <span className="w-40 shrink-0 text-right text-xs text-muted-foreground">
                    {reason}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
