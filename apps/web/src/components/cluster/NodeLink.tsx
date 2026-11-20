import { Link } from 'react-router-dom';
import { clusterNodePath, type ServedClusterNodeRef } from '@betterdb/shared';
import { badgeVariants } from '../ui/badge';
import { cn } from '../../lib/utils';

interface NodeLinkProps {
  node: ServedClusterNodeRef;
  connectionId?: string;
  className?: string;
}

function detailsOf(node: ServedClusterNodeRef): string {
  return [
    node.role === 'unknown' ? null : node.role,
    node.shardId ? `shard ${node.shardId.substring(0, 8)}` : null,
    node.availabilityZone ?? null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

export function NodeLink({ node, connectionId, className }: NodeLinkProps) {
  const details = detailsOf(node);
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5 text-xs', className)}>
      <Link
        to={clusterNodePath(node.nodeId, connectionId)}
        title="Open this node in the cluster view"
        className="font-mono text-primary hover:underline"
        onClick={(event) => event.stopPropagation()}
      >
        {node.address}
      </Link>
      {details && <span className="text-muted-foreground">{details}</span>}
      {!node.collected && (
        <span
          className={cn(badgeVariants({ variant: 'outline' }), 'text-[10px]')}
          title="BetterDB has no connection of its own to this node. Open the node to connect to it."
        >
          Not collected
        </span>
      )}
    </span>
  );
}
