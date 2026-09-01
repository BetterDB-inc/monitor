import type { NotScannedNode } from '@betterdb/shared';

interface NotScannedListProps {
  nodes: NotScannedNode[];
}

export function NotScannedList({ nodes }: NotScannedListProps) {
  if (nodes.length === 0) {
    return null;
  }

  return (
    <details data-testid="not-scanned-list" className="rounded-lg border p-4" open>
      <summary className="cursor-pointer text-sm font-medium">
        {nodes.length} {nodes.length === 1 ? 'node' : 'nodes'} not scanned
      </summary>
      <ul className="mt-3 space-y-1 text-sm">
        {nodes.map((entry) => {
          return (
            <li key={entry.nodeId} className="text-muted-foreground">
              <span>{entry.address}</span> — <span>{entry.reason}</span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
