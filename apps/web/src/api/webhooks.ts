import { fetchApi } from './client';
import type { Webhook, WebhookDelivery, WebhookFormData, TestWebhookResponse } from '../types/webhooks';

export const webhooksApi = {
  /**
   * Get all webhooks
   */
  getWebhooks: async (): Promise<Webhook[]> => {
    return fetchApi('/webhooks');
  },

  /**
   * Get a specific webhook by ID
   */
  getWebhook: async (id: string): Promise<Webhook> => {
    return fetchApi(`/webhooks/${id}`);
  },

  /**
   * Create a new webhook
   */
  createWebhook: async (data: WebhookFormData): Promise<Webhook> => {
    return fetchApi('/webhooks', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  /**
   * Update an existing webhook
   */
  updateWebhook: async (id: string, data: Partial<WebhookFormData>): Promise<Webhook> => {
    return fetchApi(`/webhooks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  /**
   * Delete a webhook
   */
  deleteWebhook: async (id: string): Promise<void> => {
    return fetchApi(`/webhooks/${id}`, {
      method: 'DELETE',
    });
  },

  /**
   * Test a webhook by sending a test payload
   */
  testWebhook: async (id: string): Promise<TestWebhookResponse> => {
    return fetchApi(`/webhooks/${id}/test`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  /**
   * Get deliveries for a specific webhook
   */
  getDeliveries: async (webhookId: string, limit: number = 50): Promise<WebhookDelivery[]> => {
    return fetchApi(`/webhooks/${webhookId}/deliveries?limit=${limit}`);
  },

  /**
   * Retry a failed delivery
   */
  retryDelivery: async (deliveryId: string): Promise<{ message: string }> => {
    return fetchApi(`/webhooks/deliveries/${deliveryId}/retry`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
};
