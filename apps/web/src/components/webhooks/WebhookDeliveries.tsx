import { useState, useEffect } from 'react';
import { WebhookDelivery, Webhook } from '../../types/webhooks';
import { webhooksApi } from '../../api/webhooks';
import { Card } from '../ui/card';
import { Badge } from '../ui/badge';
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from '../ui/table';

interface WebhookDeliveriesProps {
  webhook: Webhook;
  onClose: () => void;
}

export function WebhookDeliveries({ webhook, onClose }: WebhookDeliveriesProps) {
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState<string | null>(null);

  useEffect(() => {
    loadDeliveries();
  }, [webhook.id]);

  const loadDeliveries = async () => {
    try {
      setLoading(true);
      const data = await webhooksApi.getDeliveries(webhook.id, 100);
      setDeliveries(data);
    } catch (error) {
      console.error('Failed to load deliveries:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleRetry = async (deliveryId: string) => {
    try {
      setRetrying(deliveryId);
      await webhooksApi.retryDelivery(deliveryId);
      // Reload deliveries after retry
      await loadDeliveries();
      alert('Delivery retry initiated successfully');
    } catch (error) {
      console.error('Failed to retry delivery:', error);
      alert('Failed to retry delivery. Please try again.');
    } finally {
      setRetrying(null);
    }
  };

  const formatTimestamp = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, 'success' | 'destructive' | 'warning' | 'secondary'> = {
      success: 'success',
      failed: 'destructive',
      retrying: 'warning',
      pending: 'secondary',
    };

    return <Badge variant={variants[status] || 'secondary'}>{status}</Badge>;
  };

  if (loading) {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Delivery History: {webhook.name}</h2>
          <button
            onClick={onClose}
            className="px-4 py-2 border rounded-md hover:bg-gray-50"
          >
            Close
          </button>
        </div>
        <div className="text-center py-8 text-gray-500">Loading deliveries...</div>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold">Delivery History: {webhook.name}</h2>
          <p className="text-sm text-gray-500 mt-1">Showing last 100 deliveries</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadDeliveries}
            className="px-4 py-2 border rounded-md hover:bg-gray-50"
          >
            Refresh
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 border rounded-md hover:bg-gray-50"
          >
            Close
          </button>
        </div>
      </div>

      {deliveries.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          No deliveries found for this webhook.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>HTTP Code</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Created At</TableHead>
                <TableHead>Completed At</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.map((delivery) => (
                <TableRow key={delivery.id}>
                  <TableCell className="font-mono text-xs">{delivery.eventType}</TableCell>
                  <TableCell>{getStatusBadge(delivery.status)}</TableCell>
                  <TableCell>
                    {delivery.statusCode ? (
                      <span
                        className={`font-mono ${
                          delivery.statusCode >= 200 && delivery.statusCode < 300
                            ? 'text-green-600'
                            : 'text-red-600'
                        }`}
                      >
                        {delivery.statusCode}
                      </span>
                    ) : (
                      <span className="text-gray-400">-</span>
                    )}
                  </TableCell>
                  <TableCell>{delivery.attempts}</TableCell>
                  <TableCell>
                    {delivery.durationMs ? `${delivery.durationMs}ms` : '-'}
                  </TableCell>
                  <TableCell className="text-xs">
                    {formatTimestamp(delivery.createdAt)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {delivery.completedAt ? formatTimestamp(delivery.completedAt) : '-'}
                  </TableCell>
                  <TableCell>
                    {delivery.status === 'failed' && (
                      <button
                        onClick={() => handleRetry(delivery.id)}
                        disabled={retrying === delivery.id}
                        className="text-sm text-blue-600 hover:text-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {retrying === delivery.id ? 'Retrying...' : 'Retry'}
                      </button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Delivery Details */}
      {deliveries.length > 0 && (
        <div className="mt-6 space-y-4">
          <h3 className="text-lg font-semibold">Latest Delivery Details</h3>
          <div className="bg-gray-50 rounded-md p-4 space-y-2 text-sm">
            <div>
              <span className="font-medium">Delivery ID:</span> {deliveries[0].id}
            </div>
            <div>
              <span className="font-medium">Webhook ID:</span> {deliveries[0].webhookId}
            </div>
            {deliveries[0].responseBody && (
              <div>
                <span className="font-medium">Response Body:</span>
                <pre className="mt-1 p-2 bg-white border rounded text-xs overflow-x-auto">
                  {deliveries[0].responseBody}
                </pre>
              </div>
            )}
            {deliveries[0].nextRetryAt && (
              <div>
                <span className="font-medium">Next Retry At:</span>{' '}
                {formatTimestamp(deliveries[0].nextRetryAt)}
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
