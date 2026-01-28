import { useState, useEffect } from 'react';
import { Webhook, WebhookFormData, WebhookEventType } from '../../types/webhooks';
import {
  Tier,
  getEventsByTierCategory,
  isEventAllowedForTier
} from '@betterdb/shared';
import { Card } from '../ui/card';
import { licenseApi } from '../../api/license';

interface WebhookFormProps {
  webhook?: Webhook;
  onSubmit: (data: WebhookFormData) => Promise<void>;
  onCancel: () => void;
}

// Human-readable event labels
const EVENT_LABELS: Record<WebhookEventType, string> = {
  'instance.down': 'Instance Down',
  'instance.up': 'Instance Up',
  'memory.critical': 'Memory Critical',
  'connection.critical': 'Connection Critical',
  'client.blocked': 'Client Blocked',
  'anomaly.detected': 'Anomaly Detected',
  'slowlog.threshold': 'Slowlog Threshold',
  'replication.lag': 'Replication Lag',
  'cluster.failover': 'Cluster Failover',
  'latency.spike': 'Latency Spike',
  'connection.spike': 'Connection Spike',
  'audit.policy.violation': 'Audit Policy Violation',
  'compliance.alert': 'Compliance Alert',
  'acl.violation': 'ACL Violation',
  'acl.modified': 'ACL Modified',
  'config.changed': 'Config Changed',
};

// Tier display names
const TIER_DISPLAY: Record<Tier, string> = {
  [Tier.community]: 'Community',
  [Tier.pro]: 'Pro',
  [Tier.enterprise]: 'Enterprise',
};

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
  const [userTier, setUserTier] = useState<Tier>(Tier.community);
  const [loadingTier, setLoadingTier] = useState(true);

  useEffect(() => {
    // Fetch user's license tier
    const fetchTier = async () => {
      try {
        const license = await licenseApi.getStatus();
        setUserTier(license.tier);
      } catch (error) {
        console.error('Failed to fetch license status:', error);
        // Default to community tier on error
        setUserTier(Tier.community);
      } finally {
        setLoadingTier(false);
      }
    };
    fetchTier();
  }, []);

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
    // Prevent toggling locked events
    if (!isEventAllowedForTier(event, userTier)) {
      return;
    }

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
            {loadingTier ? (
              <div className="border rounded-md p-4 text-center text-sm text-gray-500">
                Loading available events...
              </div>
            ) : (
              <div className="border rounded-md p-3 max-h-96 overflow-y-auto space-y-4">
                {(Object.entries(getEventsByTierCategory()) as [Tier, WebhookEventType[]][]).map(
                  ([tier, events]) => {
                    const tierAllowed = isEventAllowedForTier(events[0] || 'instance.down' as WebhookEventType, userTier);

                    return (
                      <div key={tier}>
                        <div className="flex items-center justify-between mb-2">
                          <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
                            {TIER_DISPLAY[tier]} Tier
                          </h4>
                          {!tierAllowed && (
                            <span className="text-xs px-2 py-0.5 bg-yellow-100 text-yellow-800 rounded">
                              Requires {TIER_DISPLAY[tier]}
                            </span>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          {events.map((event) => {
                            const isAllowed = isEventAllowedForTier(event, userTier);
                            const isChecked = formData.events.includes(event);

                            return (
                              <label
                                key={event}
                                className={`flex items-center space-x-2 p-2 rounded ${
                                  isAllowed
                                    ? 'cursor-pointer hover:bg-gray-50'
                                    : 'cursor-not-allowed opacity-60 bg-gray-50'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  disabled={!isAllowed}
                                  onChange={() => handleEventToggle(event)}
                                  className={!isAllowed ? 'cursor-not-allowed' : ''}
                                />
                                <span className="text-sm flex-1">
                                  {EVENT_LABELS[event]}
                                </span>
                                {!isAllowed && (
                                  <svg
                                    className="w-4 h-4 text-gray-400"
                                    fill="currentColor"
                                    viewBox="0 0 20 20"
                                  >
                                    <path
                                      fillRule="evenodd"
                                      d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z"
                                      clipRule="evenodd"
                                    />
                                  </svg>
                                )}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  }
                )}

                {/* Upgrade CTA */}
                {userTier !== Tier.enterprise && (
                  <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-md">
                    <p className="text-sm text-blue-900">
                      {userTier === Tier.community && (
                        <>
                          <strong>Unlock more events:</strong> Upgrade to Pro for advanced monitoring events or Enterprise for compliance and audit events.
                        </>
                      )}
                      {userTier === Tier.pro && (
                        <>
                          <strong>Unlock Enterprise events:</strong> Upgrade to Enterprise for compliance alerts, audit policy violations, and more.
                        </>
                      )}
                    </p>
                  </div>
                )}
              </div>
            )}
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
