import { useState } from 'react';
import type { ReplicationLagEntry } from '@betterdb/shared';
import { formatBytes } from '../../lib/utils';

interface Props {
  entries: ReplicationLagEntry[];
  expectedShards: number | null;
  now: number;
}

const FRESHNESS_FLOOR_MS = 10_000;
const LOG_INTERVAL_MS = 1_000;

function readout(entries: ReplicationLagEntry[], expectedShards: number | null): string {
  const known = entries.flatMap((e) => (e.diff === null ? [] : [e.diff]));
  const base = known.length === 0 ? 'Lag: initial sync' : `Lag: ${formatBytes(Math.max(...known))} behind`;
  if (expectedShards !== null && entries.length < expectedShards) {
    return `${base} · waiting for ${expectedShards - entries.length} of ${expectedShards} shards`;
  }
  return base;
}

export function ReplicationLag({ entries, expectedShards, now }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (entries.length === 0) return null;

  const window = Math.max(FRESHNESS_FLOOR_MS, 3 * (expectedShards ?? entries.length) * LOG_INTERVAL_MS);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="text-sm text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
      >
        {readout(entries, expectedShards)}
      </button>
      {expanded && (
        <ul className="absolute z-10 mt-1 min-w-48 rounded-md border bg-card p-2 text-xs shadow-sm space-y-0.5">
          {entries.map((e) => {
            const value = e.diff === null ? 'initial sync' : formatBytes(e.diff);
            const age = now - e.updatedAt;
            const stale = age > window ? ` · updated ${Math.round(age / 1000)}s ago` : '';
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
