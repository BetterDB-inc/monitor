// Re-export webhook types from shared package
import type {
  Webhook as SharedWebhook,
  WebhookDelivery as SharedWebhookDelivery,
  WebhookEventType as SharedWebhookEventType,
  WebhookPayload as SharedWebhookPayload,
  DeliveryStatus as SharedDeliveryStatus,
  RetryPolicy as SharedRetryPolicy,
} from '@betterdb/shared';

export type Webhook = SharedWebhook;
export type WebhookDelivery = SharedWebhookDelivery;
export type WebhookEventType = SharedWebhookEventType;
export type WebhookPayload = SharedWebhookPayload;
export type DeliveryStatus = SharedDeliveryStatus;
export type RetryPolicy = SharedRetryPolicy;

// Additional frontend-specific types
export interface WebhookFormData {
  name: string;
  url: string;
  secret?: string;
  enabled: boolean;
  events: SharedWebhookEventType[];
  headers?: Record<string, string>;
  retryPolicy: SharedRetryPolicy;
}

export interface TestWebhookResponse {
  success: boolean;
  statusCode?: number;
  responseBody?: string;
  error?: string;
  durationMs: number;
}
