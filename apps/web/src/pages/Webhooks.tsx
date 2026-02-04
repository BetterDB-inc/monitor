import { useState, useEffect } from 'react';
import { webhooksApi } from '../api/webhooks';
import { Webhook, WebhookFormData, TestWebhookResponse } from '../types/webhooks';
import { WebhookList } from '../components/webhooks/WebhookList';
import { WebhookForm } from '../components/webhooks/WebhookForm';
import { WebhookDeliveries } from '../components/webhooks/WebhookDeliveries';
import { Card } from '../components/ui/card';
import { useConnection } from '../hooks/useConnection';

type View = 'list' | 'create' | 'edit' | 'deliveries';

export function Webhooks() {
  const { currentConnection } = useConnection();
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>('list');
  const [selectedWebhook, setSelectedWebhook] = useState<Webhook | null>(null);
  const [testResult, setTestResult] = useState<TestWebhookResponse | null>(null);

  useEffect(() => {
    loadWebhooks();
  }, [currentConnection?.id]);

  const loadWebhooks = async () => {
    try {
      setLoading(true);
      const data = await webhooksApi.getWebhooks();
      setWebhooks(data);
    } catch (error) {
      console.error('Failed to load webhooks:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (data: WebhookFormData) => {
    await webhooksApi.createWebhook(data);
    await loadWebhooks();
    setView('list');
  };

  const handleUpdate = async (data: WebhookFormData) => {
    if (!selectedWebhook) return;
    await webhooksApi.updateWebhook(selectedWebhook.id, data);
    await loadWebhooks();
    setView('list');
    setSelectedWebhook(null);
  };

  const handleDelete = async (webhook: Webhook) => {
    if (!confirm(`Are you sure you want to delete webhook "${webhook.name}"?`)) {
      return;
    }

    try {
      await webhooksApi.deleteWebhook(webhook.id);
      await loadWebhooks();
    } catch (error) {
      console.error('Failed to delete webhook:', error);
      alert('Failed to delete webhook. Please try again.');
    }
  };

  const handleTest = async (webhook: Webhook) => {
    try {
      setTestResult(null);
      const result = await webhooksApi.testWebhook(webhook.id);
      setTestResult(result);
    } catch (error) {
      console.error('Failed to test webhook:', error);
      setTestResult({
        success: false,
        error: 'Failed to test webhook',
        durationMs: 0,
      });
    }
  };

  const handleEdit = (webhook: Webhook) => {
    setSelectedWebhook(webhook);
    setView('edit');
  };

  const handleViewDeliveries = (webhook: Webhook) => {
    setSelectedWebhook(webhook);
    setView('deliveries');
  };

  const handleCancelForm = () => {
    setView('list');
    setSelectedWebhook(null);
  };

  const handleCloseDeliveries = () => {
    setView('list');
    setSelectedWebhook(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-lg text-gray-500">Loading webhooks...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Webhooks</h1>
          <p className="text-sm text-gray-500 mt-1">
            Configure webhooks to receive real-time notifications for events
          </p>
        </div>
        {view === 'list' && (
          <button
            onClick={() => setView('create')}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
          >
            Create Webhook
          </button>
        )}
      </div>

      {/* Test Result */}
      {testResult && (
        <Card className="p-4">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <h3 className="font-semibold mb-2">
                {testResult.success ? 'Test Successful' : 'Test Failed'}
              </h3>
              <div className="space-y-1 text-sm">
                {testResult.statusCode && (
                  <div>
                    <span className="font-medium">Status Code:</span>{' '}
                    <span
                      className={
                        testResult.statusCode >= 200 && testResult.statusCode < 300
                          ? 'text-green-600'
                          : 'text-red-600'
                      }
                    >
                      {testResult.statusCode}
                    </span>
                  </div>
                )}
                <div>
                  <span className="font-medium">Duration:</span> {testResult.durationMs}ms
                </div>
                {testResult.responseBody && (
                  <div>
                    <span className="font-medium">Response:</span>
                    <pre className="mt-1 p-2 bg-gray-50 border rounded text-xs overflow-x-auto">
                      {testResult.responseBody}
                    </pre>
                  </div>
                )}
                {testResult.error && (
                  <div>
                    <span className="font-medium">Error:</span>{' '}
                    <span className="text-red-600">{testResult.error}</span>
                  </div>
                )}
              </div>
            </div>
            <button
              onClick={() => setTestResult(null)}
              className="text-gray-400 hover:text-gray-600"
            >
              ✕
            </button>
          </div>
        </Card>
      )}

      {/* Main Content */}
      {view === 'list' && (
        <WebhookList
          webhooks={webhooks}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onTest={handleTest}
          onViewDeliveries={handleViewDeliveries}
        />
      )}

      {view === 'create' && (
        <WebhookForm onSubmit={handleCreate} onCancel={handleCancelForm} />
      )}

      {view === 'edit' && selectedWebhook && (
        <WebhookForm
          webhook={selectedWebhook}
          onSubmit={handleUpdate}
          onCancel={handleCancelForm}
        />
      )}

      {view === 'deliveries' && selectedWebhook && (
        <WebhookDeliveries webhook={selectedWebhook} onClose={handleCloseDeliveries} />
      )}

      {/* Info Section */}
      {view === 'list' && webhooks.length === 0 && (
        <Card className="p-6">
          <h3 className="text-lg font-semibold mb-2">Getting Started with Webhooks</h3>
          <div className="text-sm text-gray-600 space-y-2">
            <p>
              Webhooks allow you to receive real-time HTTP notifications when events occur in your
              BetterDB instance.
            </p>
            <ul className="list-disc list-inside space-y-1 ml-4">
              <li>Configure your endpoint URL and select events to subscribe to</li>
              <li>Secure your webhooks with HMAC signature verification</li>
              <li>Automatic retry with exponential backoff for failed deliveries</li>
              <li>Track delivery history and retry failed attempts</li>
            </ul>
            <p className="mt-4">
              <strong>Available Events:</strong> Instance health, memory alerts, client analytics,
              anomaly detection, cluster failover, audit violations, and more.
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}
