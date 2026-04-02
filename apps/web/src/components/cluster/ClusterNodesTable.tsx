import { useState, useMemo, Fragment } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '../ui/table';
import { ChevronDown, ChevronRight, Server, Copy } from 'lucide-react';
import type { ClusterNode } from '../../types/metrics';
import { formatSlotRanges, countSlots } from '../../types/cluster';

interface ClusterNodesTableProps {
  nodes: ClusterNode[];
}

type SortColumn = 'address' | 'role' | 'slots' | 'state';
type SortDirection = 'asc' | 'desc';
type FilterTab = 'all' | 'masters' | 'replicas';

export function ClusterNodesTable({ nodes }: ClusterNodesTableProps) {
  const [sortColumn, setSortColumn] = useState<SortColumn>('address');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [expandedNode, setExpandedNode] = useState<string | null>(null);

  // Build node map for master lookups
  const nodeMap = useMemo(() => {
    const map = new Map<string, ClusterNode>();
    nodes.forEach((node) => map.set(node.id, node));
    return map;
  }, [nodes]);

  const filteredNodes = useMemo(() => {
    let filtered = nodes;

    if (filterTab === 'masters') {
      filtered = nodes.filter((n) => n.flags.includes('master'));
    } else if (filterTab === 'replicas') {
      filtered = nodes.filter((n) => n.flags.includes('slave') || n.flags.includes('replica'));
    }

    return filtered;
  }, [nodes, filterTab]);

  const sortedNodes = useMemo(() => {
    const sorted = [...filteredNodes];

    sorted.sort((a, b) => {
      let aVal: string | number;
      let bVal: string | number;

      switch (sortColumn) {
        case 'address':
          aVal = a.address;
          bVal = b.address;
          break;
        case 'role':
          aVal = a.flags.includes('master') ? 'master' : 'replica';
          bVal = b.flags.includes('master') ? 'master' : 'replica';
          break;
        case 'slots':
          aVal = countSlots(a.slots);
          bVal = countSlots(b.slots);
          break;
        case 'state':
          aVal = a.linkState;
          bVal = b.linkState;
          break;
      }

      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });

    return sorted;
  }, [filteredNodes, sortColumn, sortDirection]);

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const toggleExpanded = (nodeId: string) => {
    setExpandedNode(expandedNode === nodeId ? null : nodeId);
  };

  const getRoleBadge = (node: ClusterNode) => {
    if (node.flags.includes('master')) {
      return (
        <Badge className="bg-primary/10 text-primary border-0">Master</Badge>
      );
    }
    return (
      <Badge className="bg-muted text-muted-foreground border-0">Replica</Badge>
    );
  };

  const getStateBadge = (state: string) => {
    if (state === 'connected') {
      return (
        <Badge className="bg-green-500/10 text-green-500 border-0">Connected</Badge>
      );
    }
    return (
      <Badge className="bg-destructive/10 text-destructive border-0">Disconnected</Badge>
    );
  };

  const getMasterAddress = (node: ClusterNode) => {
    if (node.master === '-') return 'N/A';
    const masterNode = nodeMap.get(node.master);
    return masterNode?.address || node.master.substring(0, 8);
  };

  const tabs: { key: FilterTab; label: string }[] = [
    { key: 'all', label: 'All Nodes' },
    { key: 'masters', label: 'Masters' },
    { key: 'replicas', label: 'Replicas' },
  ];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Cluster Nodes</CardTitle>
          <div className="flex gap-2">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setFilterTab(tab.key)}
                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                  filterTab === tab.key
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted hover:bg-muted/80'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12"></TableHead>
              <TableHead
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => handleSort('address')}
              >
                Address {sortColumn === 'address' && (sortDirection === 'asc' ? '↑' : '↓')}
              </TableHead>
              <TableHead
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => handleSort('role')}
              >
                Role {sortColumn === 'role' && (sortDirection === 'asc' ? '↑' : '↓')}
              </TableHead>
              <TableHead
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => handleSort('state')}
              >
                State {sortColumn === 'state' && (sortDirection === 'asc' ? '↑' : '↓')}
              </TableHead>
              <TableHead
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => handleSort('slots')}
              >
                Slots {sortColumn === 'slots' && (sortDirection === 'asc' ? '↑' : '↓')}
              </TableHead>
              <TableHead>Master</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedNodes.map((node) => {
              const isExpanded = expandedNode === node.id;
              const isMaster = node.flags.includes('master');
              const slotCount = countSlots(node.slots);

              return (
                <Fragment key={node.id}>
                  <TableRow
                    className="cursor-pointer"
                    onClick={() => toggleExpanded(node.id)}
                  >
                    <TableCell>
                      {isExpanded ? (
                        <ChevronDown className="w-4 h-4" />
                      ) : (
                        <ChevronRight className="w-4 h-4" />
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      <div className="flex items-center gap-2">
                        <Server className="w-4 h-4 text-muted-foreground" />
                        {node.address}
                        {node.flags.includes('myself') && (
                          <Badge className="bg-primary/10 text-primary border-0 text-[10px]">
                            MYSELF
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{getRoleBadge(node)}</TableCell>
                    <TableCell>{getStateBadge(node.linkState)}</TableCell>
                    <TableCell>
                      {isMaster ? (
                        <span className="font-medium">{slotCount.toLocaleString()}</span>
                      ) : (
                        <span className="text-muted-foreground">N/A</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {!isMaster ? (
                        <span className="text-sm text-muted-foreground font-mono">
                          {getMasterAddress(node)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>

                  {/* Expanded Details */}
                  {isExpanded && (
                    <TableRow>
                      <TableCell colSpan={6} className="bg-muted/30">
                        <div className="p-4 space-y-3 text-sm">
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <span className="text-muted-foreground">Node ID:</span>
                              <div className="font-mono text-xs flex items-center gap-2 mt-1">
                                {node.id}
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    navigator.clipboard.writeText(node.id);
                                  }}
                                  className="p-1 hover:bg-muted rounded"
                                  title="Copy node ID"
                                  aria-label="Copy node ID"
                                >
                                  <Copy className="w-3 h-3" />
                                </button>
                              </div>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Flags:</span>
                              <div className="flex flex-wrap gap-1 mt-1">
                                {node.flags.map((flag) => (
                                  <Badge
                                    key={flag}
                                    className="bg-muted text-xs"
                                    variant="outline"
                                  >
                                    {flag}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Ping Sent:</span>
                              <div className="font-mono mt-1">{node.pingSent}</div>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Pong Received:</span>
                              <div className="font-mono mt-1">{node.pongReceived}</div>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Config Epoch:</span>
                              <div className="font-mono mt-1">{node.configEpoch}</div>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Link State:</span>
                              <div className="mt-1">{getStateBadge(node.linkState)}</div>
                            </div>
                          </div>
                          {isMaster && node.slots.length > 0 && (
                            <div>
                              <span className="text-muted-foreground">Slot Ranges:</span>
                              <div className="font-mono text-xs mt-1 p-2 bg-background rounded">
                                {formatSlotRanges(node.slots)}
                              </div>
                            </div>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>

        {sortedNodes.length === 0 && (
          <div className="text-center py-8 text-muted-foreground">
            No nodes found in the selected filter
          </div>
        )}
      </CardContent>
    </Card>
  );
}
