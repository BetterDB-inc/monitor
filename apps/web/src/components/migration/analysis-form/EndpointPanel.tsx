import { X } from 'lucide-react';
import type { Connection } from '../../../hooks/useConnection';
import { Button } from '../../ui/button';
import { EngineBadge } from './EngineBadge';

export type EndpointRole = 'source' | 'target';

interface Props {
  role: EndpointRole;
  connection: Connection | null;
  isPrefilled: boolean;
  selectableCount: number;
  offlineCount: number;
  agentCount: number;
  onChoose: () => void;
  onClear: () => void;
}

const ROLE_LABEL: Record<EndpointRole, string> = {
  source: 'Source · migrating from',
  target: 'Target · migrating to',
};

function availabilitySummary(
  selectableCount: number,
  offlineCount: number,
  agentCount: number,
): string {
  const parts = [`${selectableCount} available`];
  if (offlineCount > 0) {
    parts.push(`${offlineCount} offline`);
  }
  if (agentCount > 0) {
    parts.push(`${agentCount} via agent`);
  }
  return parts.join(' · ');
}

export function EndpointPanel({
  role,
  connection,
  isPrefilled,
  selectableCount,
  offlineCount,
  agentCount,
  onChoose,
  onClear,
}: Props) {
  if (connection === null) {
    return (
      <div className="flex min-h-[250px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-center">
        <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          {ROLE_LABEL[role]}
        </span>
        <span className="text-sm font-medium text-muted-foreground">
          Choose {role === 'source' ? 'a source' : 'a target'} instance
        </span>
        <span className="text-xs text-muted-foreground/80">
          {availabilitySummary(selectableCount, offlineCount, agentCount)}
        </span>
        <Button variant="outline" size="sm" className="mt-1" onClick={onChoose}>
          Select {role}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-[250px] flex-col gap-3 rounded-xl border bg-card p-5">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          {ROLE_LABEL[role]}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="-mt-1.5 -mr-1.5 text-muted-foreground"
          onClick={onClear}
          aria-label={`Clear ${role}`}
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xl font-semibold tracking-tight">{connection.name}</span>
        {isPrefilled && (
          <span className="rounded bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            Current connection
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <EngineBadge capabilities={connection.capabilities} />
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className={`size-2 rounded-full ${
              connection.isConnected ? 'bg-success' : 'bg-muted-foreground'
            }`}
          />
          {connection.isConnected ? 'Online' : 'Offline'}
        </span>
      </div>

      <span className="font-mono text-xs text-muted-foreground">
        {connection.host}:{connection.port}
        {connection.connectionType === 'agent' ? ' · via agent' : ' · direct'}
      </span>

      <Button variant="outline" size="sm" className="mt-auto self-start" onClick={onChoose}>
        Change {role}
      </Button>
    </div>
  );
}
