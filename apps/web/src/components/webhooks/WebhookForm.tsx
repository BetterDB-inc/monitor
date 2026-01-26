import { useState, useEffect } from 'react';
import { Webhook, WebhookFormData, WebhookEventType } from '../../types/webhooks';
import { Card } from '../ui/card';

interface WebhookFormProps {
  webhook?: Webhook;
  onSubmit: (data: WebhookFormData) => Promise<void>;
  onCancel: () => void;
}

// Available webhook events
const WEBHOOK_EVENTS: { value: WebhookEventType; label: string; tier: string }[] = [
  // Free tier events
  { value: 'instance.down' as WebhookEventType, label: 'Instance Down', tier: 'Free' },
  { value: 'instance.up' as WebhookEventType, label: 'Instance Up', tier: 'Free' },
  { value: 'memory.critical' as WebhookEventType, label: 'Memory Critical', tier: 'Free' },
  { value: 'client.blocked' as WebhookEventType, label: 'Client Blocked', tier: 'Free' },

  // Pro tier events
  { value: 'replication.lag' as WebhookEventType, label: 'Replication Lag', tier: 'Pro' },
  { value: 'cluster.failover' as WebhookEventType, label: 'Cluster Failover', tier: 'Pro' },
  { value: 'anomaly.detected' as WebhookEventType, label: 'Anomaly Detected', tier: 'Pro' },
  { value: 'slowlog.threshold' as WebhookEventType, label: 'Slowlog Threshold', tier: 'Pro' },

  // Enterprise tier events
  { value: 'audit.policy.violation' as WebhookEventType, label: 'Audit Policy Violation', tier: 'Enterprise' },
  { value: 'compliance.alert' as WebhookEventType, label: 'Compliance Alert', tier: 'Enterprise' },
];

export function WebhookForm({ webhook, onSubmit, onCancel }: WebhookFormProps) {
  const [formData, setFormData] = useState<WebhookFormData>({
    name: '',
    url: '',
    secret: '',
    enabled: true,
    events: [],
    headers: {},
    retryPolicy: {
      maxRetries: 3,
      backoffMultiplier: 2,
      initialDelayMs: 1000,
      maxDelayMs: 60000,
    },
  });
  const [customHeaders, setCustomHeaders] = useState<Array<{ key: string; value: string }>>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (webhook) {
      setFormData({
        name: webhook.name,
        url: webhook.url,
        secret: webhook.secret,
        enabled: webhook.enabled,
        events: webhook.events,
        headers: webhook.headers || {},
        retryPolicy: webhook.retryPolicy,
      });

      if (webhook.headers) {
        setCustomHeaders(
          Object.entries(webhook.headers).map(([key, value]) => ({ key, value }))
        );
      }
    }
  }, [webhook]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      setSubmitting(true);

      // Convert custom headers array to object
      const headers: Record<string, string> = {};
      customHeaders.forEach(({ key, value }) => {
        if (key && value) {
          headers[key] = value;
        }
      });

      await onSubmit({
        ...formData,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      });
    } catch (error) {
      console.error('Failed to submit webhook:', error);
      alert('Failed to save webhook. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleEventToggle = (event: WebhookEventType) => {
    setFormData((prev) => ({
      ...prev,
      events: prev.events.includes(event)
        ? prev.events.filter((e) => e !== event)
        : [...prev.events, event],
    }));
  };

  const addHeader = () => {
    setCustomHeaders([...customHeaders, { key: '', value: '' }]);
  };

  const removeHeader = (index: number) => {
    setCustomHeaders(customHeaders.filter((_, i) => i !== index));
  };

  const updateHeader = (index: number, field: 'key' | 'value', value: string) => {
    const updated = [...customHeaders];
    updated[index][field] = value;
    setCustomHeaders(updated);
  };

  return (
    <form onSubmit={handleSubmit}>
      <Card className="p-6">
        <h2 className="text-xl font-semibold mb-4">
          {webhook ? 'Edit Webhook' : 'Create Webhook'}
        </h2>

        <div className="space-y-4">
          {/* Basic Info */}
          <div>
            <label className="block text-sm font-medium mb-1">Name *</label>
            <input
              type="text"
              required
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="w-full px-3 py-2 border rounded-md"
              placeholder="Production Alerts"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">URL *</label>
            <input
              type="url"
              required
              value={formData.url}
              onChange={(e) => setFormData({ ...formData, url: e.target.value })}
              className="w-full px-3 py-2 border rounded-md"
              placeholder="https://api.example.com/webhooks"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Secret (optional)</label>
            <input
              type="text"
              value={formData.secret || ''}
              onChange={(e) => setFormData({ ...formData, secret: e.target.value })}
              className="w-full px-3 py-2 border rounded-md"
              placeholder="wh_secret_abc123"
            />
            <p className="text-xs text-gray-500 mt-1">
              Used for HMAC signature verification (X-Webhook-Signature header)
            </p>
          </div>

          <div className="flex items-center">
            <input
              type="checkbox"
              id="enabled"
              checked={formData.enabled}
              onChange={(e) => setFormData({ ...formData, enabled: e.target.checked })}
              className="mr-2"
            />
            <label htmlFor="enabled" className="text-sm font-medium">
              Enable webhook
            </label>
          </div>

          {/* Events */}
          <div>
            <label className="block text-sm font-medium mb-2">Events to Subscribe *</label>
            <div className="grid grid-cols-2 gap-2 border rounded-md p-3 max-h-60 overflow-y-auto">
              {WEBHOOK_EVENTS.map((event) => (
                <label key={event.value} className="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.events.includes(event.value)}
                    onChange={() => handleEventToggle(event.value)}
                  />
                  <span className="text-sm">{event.label}</span>
                  <span className="text-xs text-gray-500">({event.tier})</span>
                </label>
              ))}
            </div>
            {formData.events.length === 0 && (
              <p className="text-xs text-red-500 mt-1">Please select at least one event</p>
            )}
          </div>

          {/* Custom Headers */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium">Custom Headers</label>
              <button
                type="button"
                onClick={addHeader}
                className="text-sm text-blue-600 hover:text-blue-700"
              >
                + Add Header
              </button>
            </div>
            <div className="space-y-2">
              {customHeaders.map((header, index) => (
                <div key={index} className="flex gap-2">
                  <input
                    type="text"
                    value={header.key}
                    onChange={(e) => updateHeader(index, 'key', e.target.value)}
                    className="flex-1 px-3 py-2 border rounded-md text-sm"
                    placeholder="Header-Name"
                  />
                  <input
                    type="text"
                    value={header.value}
                    onChange={(e) => updateHeader(index, 'value', e.target.value)}
                    className="flex-1 px-3 py-2 border rounded-md text-sm"
                    placeholder="Header Value"
                  />
                  <button
                    type="button"
                    onClick={() => removeHeader(index)}
                    className="px-3 py-2 text-sm text-red-600 border border-red-600 rounded hover:bg-red-50"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Retry Policy */}
          <div>
            <label className="block text-sm font-medium mb-2">Retry Policy</label>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Max Retries</label>
                <input
                  type="number"
                  min="0"
                  max="10"
                  value={formData.retryPolicy.maxRetries}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      retryPolicy: { ...formData.retryPolicy, maxRetries: parseInt(e.target.value) },
                    })
                  }
                  className="w-full px-3 py-2 border rounded-md text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Backoff Multiplier</label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  step="0.1"
                  value={formData.retryPolicy.backoffMultiplier}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      retryPolicy: { ...formData.retryPolicy, backoffMultiplier: parseFloat(e.target.value) },
                    })
                  }
                  className="w-full px-3 py-2 border rounded-md text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Initial Delay (ms)</label>
                <input
                  type="number"
                  min="100"
                  max="60000"
                  step="100"
                  value={formData.retryPolicy.initialDelayMs}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      retryPolicy: { ...formData.retryPolicy, initialDelayMs: parseInt(e.target.value) },
                    })
                  }
                  className="w-full px-3 py-2 border rounded-md text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Max Delay (ms)</label>
                <input
                  type="number"
                  min="1000"
                  max="600000"
                  step="1000"
                  value={formData.retryPolicy.maxDelayMs}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      retryPolicy: { ...formData.retryPolicy, maxDelayMs: parseInt(e.target.value) },
                    })
                  }
                  className="w-full px-3 py-2 border rounded-md text-sm"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 mt-6 pt-6 border-t">
          <button
            type="submit"
            disabled={submitting || formData.events.length === 0}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {submitting ? 'Saving...' : webhook ? 'Update Webhook' : 'Create Webhook'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="px-4 py-2 border rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
        </div>
      </Card>
    </form>
  );
}
