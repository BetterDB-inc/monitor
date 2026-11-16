import type { ServedClusterNodeRef } from '@betterdb/shared';
import { NodeLink } from '../cluster/NodeLink';

export interface TimelineAnomalyItem {
  timestamp: number;
  severity: string;
  metricType: string;
  zScore: number;
  connectionId?: string;
  node?: ServedClusterNodeRef;
}

export function TimelineAnomalyRow({ item, age }: { item: TimelineAnomalyItem; age: string }) {
  return (
    <tr>
      <td className="py-1.5 pr-3 w-1">
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            item.severity === 'critical' ? 'bg-red-500' : 'bg-amber-500'
          }`}
        />
      </td>
      <td className="py-1.5 pr-3 whitespace-nowrap font-medium capitalize">{item.severity}</td>
      <td className="py-1.5 pr-3">{item.metricType}</td>
      <td className="py-1.5 pr-3">
        {item.node && <NodeLink node={item.node} connectionId={item.connectionId} />}
      </td>
      <td className="py-1.5 pr-3 text-muted-foreground tabular-nums whitespace-nowrap">
        z: {item.zScore.toFixed(2)}
      </td>
      <td className="py-1.5 text-xs text-muted-foreground whitespace-nowrap text-right">
        {age}
      </td>
    </tr>
  );
}
