import type { Connection } from '../../../hooks/useConnection';
import { EngineBadge } from './EngineBadge';

interface Props {
  connections: Connection[];
}

export function NoConnectionsState({ connections }: Props) {
  const hasOne = connections.length === 1;

  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
      <span
        aria-hidden="true"
        className="grid size-14 place-items-center rounded-xl border border-dashed"
      >
        <svg
          viewBox="0 0 24 24"
          className="size-6 stroke-muted-foreground"
          fill="none"
          strokeWidth="1.6"
        >
          <rect x="2" y="4" width="8" height="16" rx="2" />
          <rect x="14" y="4" width="8" height="16" rx="2" strokeDasharray="3 3" />
        </svg>
      </span>

      <h2 className="text-lg font-semibold tracking-tight">A migration needs two instances</h2>

      <p className="max-w-md text-sm text-muted-foreground">
        {hasOne
          ? 'You have one connection configured. Add the instance you want to copy data to from the connection menu at the top of the page, then come back here to plan the move.'
          : 'No connections are configured yet. Add the instances you want to migrate between from the connection menu at the top of the page, then come back here to plan the move.'}
      </p>

      {hasOne && (
        <div className="mt-2 flex items-center gap-3 rounded-lg border px-4 py-2.5 text-sm">
          <span
            aria-hidden="true"
            className={`size-2 rounded-full ${
              connections[0].isConnected ? 'bg-success' : 'bg-muted-foreground'
            }`}
          />
          <span className="font-medium">{connections[0].name}</span>
          <EngineBadge capabilities={connections[0].capabilities} />
          <span className="font-mono text-xs text-muted-foreground">
            {connections[0].host}:{connections[0].port}
          </span>
        </div>
      )}
    </div>
  );
}
