import { useState, useMemo } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { Server, ChevronDown, ChevronUp, Grid3x3, Network } from 'lucide-react';
import type { ClusterNode } from '../../types/metrics';
import type { NodeStats } from '../../types/cluster';
import { formatSlotRanges, countSlots } from '../../types/cluster';
import { ClusterTopologyGraph } from './ClusterTopologyGraph';

type ViewMode = 'grid' | 'graph';

interface ClusterTopologyProps {
  nodes: ClusterNode[];
  nodeStats?: NodeStats[];
}

export function ClusterTopology({ nodes, nodeStats }: ClusterTopologyProps) {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>('grid');

  // Organize nodes by master-replica relationships
  const topology = useMemo(() => {
    const masters = nodes.filter((n) => n.flags.includes('master'));
    const replicaMap = new Map<string, ClusterNode[]>();

    // Group replicas by their master
    nodes.forEach((node) => {
      if (node.flags.includes('slave') || node.flags.includes('replica')) {
        const masterId = node.master;
        if (!replicaMap.has(masterId)) {
          replicaMap.set(masterId, []);
        }
        replicaMap.get(masterId)!.push(node);
      }
    });

    return masters.map((master) => ({
      master,
      replicas: replicaMap.get(master.id) || [],
    }));
  }, [nodes]);

  const toggleNode = (nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  };

  const getNodeBorderColor = (node: ClusterNode): string => {
    if (node.flags.includes('fail')) return 'border-red-500';
    if (node.flags.includes('pfail')) return 'border-yellow-500';
    if (node.flags.includes('myself')) return 'border-blue-500';
    if (node.linkState === 'connected' && !node.flags.includes('fail')) {
      return 'border-green-500';
    }
    return 'border-muted';
  };

  const getNodeBgColor = (node: ClusterNode): string => {
    if (node.flags.includes('fail')) return 'bg-red-500/5';
    if (node.flags.includes('pfail')) return 'bg-yellow-500/5';
    if (node.flags.includes('myself')) return 'bg-blue-500/5';
    return '';
  };

  const renderNode = (node: ClusterNode, isMaster: boolean) => {
    const isExpanded = expandedNodes.has(node.id);
    const slotCount = countSlots(node.slots);
    const borderColor = getNodeBorderColor(node);
    const bgColor = getNodeBgColor(node);

    return (
      <div
        key={node.id}
        className={`border-2 rounded-lg p-3 ${borderColor} ${bgColor} transition-all`}
      >
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Server className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <span className="font-mono text-sm truncate">{node.address}</span>
              {node.flags.includes('myself') && (
                <Badge className="bg-blue-500/10 text-blue-500 border-0 text-[10px]">
                  MYSELF
                </Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground font-mono truncate">
              {node.id.substring(0, 12)}...
            </div>
            {isMaster && node.slots.length > 0 && (
              <div className="mt-2 text-xs">
                <span className="text-muted-foreground">Slots: </span>
                <span className="font-medium">{slotCount.toLocaleString()}</span>
              </div>
            )}
            <div className="mt-1 flex items-center gap-1">
              <Badge
                className={`text-[10px] ${
                  node.linkState === 'connected'
                    ? 'bg-green-500/10 text-green-500'
                    : 'bg-red-500/10 text-red-500'
                } border-0`}
              >
                {node.linkState}
              </Badge>
              {node.flags.includes('fail') && (
                <Badge className="bg-red-500/10 text-red-500 border-0 text-[10px]">
                  FAIL
                </Badge>
              )}
              {node.flags.includes('pfail') && (
                <Badge className="bg-yellow-500/10 text-yellow-500 border-0 text-[10px]">
                  PFAIL
                </Badge>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => toggleNode(node.id)}
            className="p-1 hover:bg-muted rounded flex-shrink-0"
            aria-label={isExpanded ? 'Collapse node details' : 'Expand node details'}
          >
            {isExpanded ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </button>
        </div>

        {/* Expanded Details */}
        {isExpanded && (
          <div className="mt-3 pt-3 border-t space-y-2 text-xs">
            <div>
              <span className="text-muted-foreground">Config Epoch: </span>
              <span className="font-mono">{node.configEpoch}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Ping Sent: </span>
              <span className="font-mono">{node.pingSent}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Pong Received: </span>
              <span className="font-mono">{node.pongReceived}</span>
            </div>
            {isMaster && node.slots.length > 0 && (
              <div>
                <span className="text-muted-foreground">Slot Ranges: </span>
                <div className="font-mono text-[10px] mt-1 p-2 bg-background rounded max-h-20 overflow-y-auto">
                  {formatSlotRanges(node.slots)}
                </div>
              </div>
            )}
            <div>
              <span className="text-muted-foreground">Flags: </span>
              <div className="flex flex-wrap gap-1 mt-1">
                {node.flags.map((flag) => (
                  <Badge
                    key={flag}
                    className="bg-muted text-[10px]"
                    variant="outline"
                  >
                    {flag}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderViewToggle = () => (
    <div className="flex items-center gap-1 border rounded-md p-1">
      <button
        onClick={() => setViewMode('grid')}
        className={`px-3 py-1.5 rounded text-sm flex items-center gap-2 transition-colors ${
          viewMode === 'grid'
            ? 'bg-primary text-primary-foreground'
            : 'hover:bg-muted'
        }`}
        title="Grid View"
        aria-label="Switch to grid view"
      >
        <Grid3x3 className="w-4 h-4" />
        Grid
      </button>
      <button
        onClick={() => setViewMode('graph')}
        className={`px-3 py-1.5 rounded text-sm flex items-center gap-2 transition-colors ${
          viewMode === 'graph'
            ? 'bg-primary text-primary-foreground'
            : 'hover:bg-muted'
        }`}
        title="Graph View"
        aria-label="Switch to graph view"
      >
        <Network className="w-4 h-4" />
        Graph
      </button>
    </div>
  );

  if (viewMode === 'graph') {
    return (
      <div className="animate-in fade-in duration-300">
        <ClusterTopologyGraph
          nodes={nodes}
          nodeStats={nodeStats}
          viewToggle={renderViewToggle()}
        />
      </div>
    );
  }

  return (
    <div className="animate-in fade-in duration-300">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">Cluster Topology</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                Master nodes with their replicas
              </p>
            </div>
            {renderViewToggle()}
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-6">
            {topology.map(({ master, replicas }) => (
              <div key={master.id} className="space-y-3">
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
                    Master
                  </div>
                  {renderNode(master, true)}
                </div>

                {replicas.length > 0 && (
                  <div className="pl-6 border-l-2 border-muted space-y-2">
                    <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Replicas ({replicas.length})
                    </div>
                    {replicas.map((replica) => renderNode(replica, false))}
                  </div>
                )}
              </div>
            ))}

            {topology.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                <Server className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p>No cluster nodes found</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
