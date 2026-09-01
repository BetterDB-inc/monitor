import type { ScannedNode } from '@betterdb/shared';
import { Badge } from '../../ui/badge';
import type { NodeGroups } from './drift-groups';

interface NodeListProps {
  nodes: ScannedNode[];
  groups: Map<string, NodeGroups>;
  selectedNodeId: string;
  onSelect: (nodeId: string) => void;
}

export function NodeList({ nodes, groups, selectedNodeId, onSelect }: NodeListProps) {
  return (
    <ul data-testid="node-list" className="divide-y rounded-lg border">
      {nodes.map((entry) => {
        const group = groups.get(entry.nodeId);
        const selected = entry.nodeId === selectedNodeId;

        return (
          <li key={entry.nodeId}>
            <button
              type="button"
              data-testid={`node-row-${entry.nodeId}`}
              onClick={() => {
                onSelect(entry.nodeId);
              }}
              className={`flex w-full items-center justify-between p-4 text-left text-sm ${selected ? 'bg-muted' : ''}`}
            >
              <span className="space-x-2">
                <span className="font-medium">{entry.address}</span>
                <span className="text-muted-foreground">{entry.role}</span>
              </span>
              <span className="flex items-center gap-3">
                <span>{entry.engineVersion}</span>
                <Badge data-testid={`node-badge-${entry.nodeId}`} variant="outline">
                  {group?.badge ?? 0}
                </Badge>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
