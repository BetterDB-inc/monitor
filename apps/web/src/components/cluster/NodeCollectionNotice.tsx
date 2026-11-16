import { useState } from 'react';
import { Link } from 'react-router-dom';
import { connectionsApi } from '../../api/connections';
import { useCanMutate } from '../../hooks/useCanMutate';
import { CONNECTION_PARAM } from '../../lib/connectionParam';
import { Button } from '../ui/button';
import type { ClusterConnectionRef, NodeCollection } from './nodeCollection';

interface NodeCollectionNoticeProps {
  nodeId: string;
  address: string;
  collection: NodeCollection | undefined;
  clusterConnection: ClusterConnectionRef | null | undefined;
  onConnected?: () => void;
}

const DOCS_URL = 'https://docs.betterdb.com/cluster-auto-registration.html';

function dialsNodes(connection: ClusterConnectionRef): boolean {
  return (
    connection.host !== 'agent' &&
    connection.connectionType !== 'agent' &&
    connection.connectionType !== 'external'
  );
}

function failureText(address: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return reason.includes(address) ? reason : `${address} was not connected. ${reason}`;
}

function nodeDashboardPath(connectionId: string): string {
  return `/?${new URLSearchParams({ [CONNECTION_PARAM]: connectionId }).toString()}`;
}

export function NodeCollectionNotice({
  nodeId,
  address,
  collection,
  clusterConnection,
  onConnected,
}: NodeCollectionNoticeProps) {
  const canMutate = useCanMutate();
  const [connecting, setConnecting] = useState(false);
  const [connectedId, setConnectedId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  if (!collection || !clusterConnection) return null;

  const nodeConnectionId = connectedId ?? (collection.collected ? collection.connectionId : undefined);
  if (nodeConnectionId) {
    if (nodeConnectionId === clusterConnection.id) return null;
    return (
      <div className="text-sm">
        <span className="text-muted-foreground">This node has its own connection. </span>
        <Link to={nodeDashboardPath(nodeConnectionId)} className="text-primary hover:underline">
          Open node dashboard
        </Link>
      </div>
    );
  }
  if (collection.collected) return null;

  const connect = async () => {
    setConnecting(true);
    setFailure(null);
    try {
      const { id } = await connectionsApi.connectClusterNode(clusterConnection.id, nodeId);
      setConnectedId(id);
      onConnected?.();
    } catch (error) {
      setFailure(failureText(address, error));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3 text-sm">
      <p>
        {address} is not registered as its own connection. BetterDB only reads it through the
        cluster connection, so its slow log, client list and per-node metrics are missing.
      </p>
      {!dialsNodes(clusterConnection) ? (
        <p className="text-muted-foreground">
          BetterDB does not open connections to the nodes of this cluster itself, because the
          cluster is read through an agent or OTLP push, so this node cannot be connected from
          here.{' '}
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            How nodes get registered
          </a>
        </p>
      ) : !canMutate ? (
        <p className="text-muted-foreground">Only an admin can connect a node.</p>
      ) : (
        <>
          <p className="text-muted-foreground">
            Every node you connect is polled on its own, and the load that adds grows with the
            size of the cluster.
          </p>
          <Button
            size="sm"
            disabled={connecting}
            onClick={(event) => {
              event.stopPropagation();
              void connect();
            }}
          >
            {connecting ? 'Connecting…' : 'Connect to this node'}
          </Button>
          {failure && (
            <p role="alert" className="text-destructive">
              {failure}
            </p>
          )}
        </>
      )}
    </div>
  );
}
