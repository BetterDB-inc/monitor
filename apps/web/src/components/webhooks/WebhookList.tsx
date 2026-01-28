import { Webhook } from '../../types/webhooks';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';

interface WebhookListProps {
  webhooks: Webhook[];
  onEdit: (webhook: Webhook) => void;
  onDelete: (webhook: Webhook) => void;
  onTest: (webhook: Webhook) => void;
  onViewDeliveries: (webhook: Webhook) => void;
}

export function WebhookList({ webhooks, onEdit, onDelete, onTest, onViewDeliveries }: WebhookListProps) {
  if (webhooks.length === 0) {
    return (
      <Card className="p-8 text-center">
        <div className="text-gray-500">
          <p className="text-lg font-medium mb-2">No webhooks configured</p>
          <p className="text-sm">Create your first webhook to get started with real-time notifications.</p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {webhooks.map((webhook) => (
        <Card key={webhook.id} className="p-6">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-2">
                <h3 className="text-lg font-semibold">{webhook.name}</h3>
                <Badge variant={webhook.enabled ? 'success' : 'secondary'}>
                  {webhook.enabled ? 'Enabled' : 'Disabled'}
                </Badge>
              </div>

              <div className="space-y-2 text-sm text-gray-600">
                <div>
                  <span className="font-medium">URL:</span> {webhook.url}
                </div>
                <div>
                  <span className="font-medium">Events:</span>{' '}
                  <span className="inline-flex flex-wrap gap-1">
                    {webhook.events.map((event) => (
                      <Badge key={event} variant="outline" className="text-xs">
                        {event}
                      </Badge>
                    ))}
                  </span>
                </div>
                <div>
                  <span className="font-medium">Retry Policy:</span> Max {webhook.retryPolicy.maxRetries} retries,
                  {' '}{webhook.retryPolicy.initialDelayMs}ms initial delay
                </div>
                {webhook.secret && (
                  <div>
                    <span className="font-medium">Secret:</span> {webhook.secret.substring(0, 12)}...
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => onTest(webhook)}
                className="px-3 py-1.5 text-sm border border-blue-600 text-blue-600 rounded hover:bg-blue-50 transition-colors"
              >
                Test
              </button>
              <button
                onClick={() => onViewDeliveries(webhook)}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 transition-colors"
              >
                Deliveries
              </button>
              <button
                onClick={() => onEdit(webhook)}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 transition-colors"
              >
                Edit
              </button>
              <button
                onClick={() => onDelete(webhook)}
                className="px-3 py-1.5 text-sm border border-red-600 text-red-600 rounded hover:bg-red-50 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
