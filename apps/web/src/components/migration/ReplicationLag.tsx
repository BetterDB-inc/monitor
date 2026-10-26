import { useState } from 'react';
import type { ReplicationLagEntry } from '@betterdb/shared';
import { formatBytes } from '../../lib/utils';

interface Props {
  entries: ReplicationLagEntry[];
  expectedShards: number | null;
}

function withWaiting(text: string, reported: number, expectedShards: number | null): string {
  if (expectedShards !== null && reported < expectedShards) {
    return `${text} · waiting for ${expectedShards - reported} of ${expectedShards} shards`;
  }
  return text;
}

function readout(entries: ReplicationLagEntry[], expectedShards: number | null): string {
  const known = entries.flatMap((e) => (e.diff === null ? [] : [e.diff]));
  if (known.length === 0) {
    return withWaiting('Lag: initial sync', entries.length, expectedShards);
  }
  const total = expectedShards ?? entries.length;
  const syncing = entries.length - known.length;
  const base = `Lag: ${formatBytes(Math.max(...known))} behind`;
  const withSyncing = syncing > 0 ? `${base} · ${syncing} of ${total} shards in initial sync` : base;
  return withWaiting(withSyncing, entries.length, expectedShards);
}

function withStale(text: string, entries: ReplicationLagEntry[]): string {
  return entries.some((e) => e.stale) ? `${text} · not updated recently` : text;
}

export function ReplicationLag({ entries, expectedShards }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (entries.length === 0) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="text-sm text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
      >
        {withStale(readout(entries, expectedShards), entries)}
      </button>
      {expanded && (
        <ul className="absolute z-10 mt-1 min-w-48 rounded-md border bg-card p-2 text-xs shadow-sm space-y-0.5">
          {entries.map((e) => {
            const value = e.diff === null ? 'initial sync' : formatBytes(e.diff);
            const stale = e.stale ? ' · not updated recently' : '';
            return (
              <li key={e.shard} className={stale ? 'text-amber-600' : 'text-muted-foreground'}>
                {`${e.shard}: ${value}${stale}`}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
