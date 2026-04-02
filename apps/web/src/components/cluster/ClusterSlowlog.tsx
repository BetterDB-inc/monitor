import { useState, useMemo } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import { Clock, Server, AlertCircle } from 'lucide-react';
import { useClusterSlowlog } from '../../hooks/useClusterSlowlog';

const MICROSECONDS_TO_MS = 1000;
const MICROSECONDS_TO_SECONDS = 1000000;
const SLOW_QUERY_THRESHOLD_US = 100000;
const VERY_SLOW_QUERY_THRESHOLD_US = 1000000;

export function ClusterSlowlog() {
  const { entries, nodeIds, slowestNode, isLoading, error } = useClusterSlowlog(100);
  const [selectedNode, setSelectedNode] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'duration' | 'timestamp'>('duration');

  const filteredAndSortedEntries = useMemo(() => {
    let filtered = selectedNode === 'all'
      ? entries
      : entries.filter((e) => e.nodeId === selectedNode);

    return filtered.sort((a, b) => {
      if (sortBy === 'duration') {
        return b.duration - a.duration;
      }
      return b.timestamp - a.timestamp;
    });
  }, [entries, selectedNode, sortBy]);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="text-center text-muted-foreground">Loading cluster slowlog...</div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="text-center text-destructive">Error loading slowlog: {error.message}</div>
        </CardContent>
      </Card>
    );
  }

  const formatDuration = (microseconds: number) => {
    if (microseconds < MICROSECONDS_TO_MS) return `${microseconds}μs`;
    if (microseconds < MICROSECONDS_TO_SECONDS) return `${(microseconds / MICROSECONDS_TO_MS).toFixed(2)}ms`;
    return `${(microseconds / MICROSECONDS_TO_SECONDS).toFixed(2)}s`;
  };

  const formatTimestamp = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Clock className="w-5 h-5" />
            Cluster Slowlog
          </CardTitle>
          <div className="flex items-center gap-3">
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'duration' | 'timestamp')}
              className="px-3 py-2 border rounded-md text-sm bg-background"
            >
              <option value="duration">By Duration</option>
              <option value="timestamp">By Time</option>
            </select>

            <select
              value={selectedNode}
              onChange={(e) => setSelectedNode(e.target.value)}
              className="px-3 py-2 border rounded-md text-sm bg-background"
            >
              <option value="all">All Nodes ({entries.length})</option>
              {nodeIds.map((nodeId) => {
                const nodeEntries = entries.filter((e) => e.nodeId === nodeId);
                const address = nodeEntries[0]?.nodeAddress || nodeId.substring(0, 8);
                return (
                  <option key={nodeId} value={nodeId}>
                    {address} ({nodeEntries.length})
                  </option>
                );
              })}
            </select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {slowestNode && selectedNode === 'all' && (
          <div className="mb-4 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-yellow-500 mt-0.5" />
            <div className="text-sm">
              <span className="font-medium">Node {slowestNode.nodeAddress}</span> has the most slow queries ({slowestNode.count} entries)
            </div>
          </div>
        )}

        {filteredAndSortedEntries.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            No slow queries found
          </div>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-12 gap-2 text-xs font-medium text-muted-foreground pb-2 border-b">
              <div className="col-span-2">Duration</div>
              <div className="col-span-2">Node</div>
              <div className="col-span-4">Command</div>
              <div className="col-span-2">Client</div>
              <div className="col-span-2">Time</div>
            </div>

            <div className="space-y-1 max-h-[500px] overflow-y-auto">
              {filteredAndSortedEntries.map((entry) => {
                const durationColor =
                  entry.duration > VERY_SLOW_QUERY_THRESHOLD_US
                    ? 'text-destructive'
                    : entry.duration > SLOW_QUERY_THRESHOLD_US
                    ? 'text-yellow-500'
                    : 'text-muted-foreground';

                return (
                  <div
                    key={`${entry.nodeId}-${entry.id}`}
                    className="grid grid-cols-12 gap-2 text-sm py-2 hover:bg-muted/50 rounded px-2"
                  >
                    <div className={`col-span-2 font-mono font-medium ${durationColor}`}>
                      {formatDuration(entry.duration)}
                    </div>
                    <div className="col-span-2">
                      <div className="flex items-center gap-1">
                        <Server className="w-3 h-3 text-muted-foreground" />
                        <span className="text-xs truncate" title={entry.nodeAddress}>
                          {entry.nodeAddress.split(':')[0]}
                        </span>
                      </div>
                    </div>
                    <div className="col-span-4 font-mono text-xs truncate" title={entry.command.join(' ')}>
                      {entry.command.join(' ')}
                    </div>
                    <div className="col-span-2 text-xs truncate" title={entry.clientAddress}>
                      {entry.clientName || entry.clientAddress}
                    </div>
                    <div className="col-span-2 text-xs text-muted-foreground">
                      {formatTimestamp(entry.timestamp)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
