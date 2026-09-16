// Re-export webhook types from shared package
import type {
  Webhook as SharedWebhook,
  WebhookDelivery as SharedWebhookDelivery,
  WebhookEventType as SharedWebhookEventType,
  WebhookPayload as SharedWebhookPayload,
  DeliveryStatus as SharedDeliveryStatus,
  RetryPolicy as SharedRetryPolicy,
  WebhookDeliveryConfig as SharedWebhookDeliveryConfig,
  WebhookAlertConfig as SharedWebhookAlertConfig,
  WebhookThresholds as SharedWebhookThresholds,
  WebhookPayloadFormat as SharedWebhookPayloadFormat,
} from '@betterdb/shared';

export type Webhook = SharedWebhook;
export type WebhookDelivery = SharedWebhookDelivery;
export type WebhookEventType = SharedWebhookEventType;
export type WebhookPayload = SharedWebhookPayload;
export type DeliveryStatus = SharedDeliveryStatus;
export type RetryPolicy = SharedRetryPolicy;
export type WebhookDeliveryConfig = SharedWebhookDeliveryConfig;
export type WebhookAlertConfig = SharedWebhookAlertConfig;
export type WebhookThresholds = SharedWebhookThresholds;
export type WebhookPayloadFormat = SharedWebhookPayloadFormat;
export { WebhookPayloadFormat as WebhookPayloadFormatEnum } from '@betterdb/shared';

// Additional frontend-specific types
export interface WebhookFormData {
  name: string;
  url: string;
  secret?: string;
  enabled: boolean;
  events: SharedWebhookEventType[];
  headers?: Record<string, string>;
  retryPolicy: SharedRetryPolicy;
  deliveryConfig?: SharedWebhookDeliveryConfig;
  alertConfig?: SharedWebhookAlertConfig;
  thresholds?: SharedWebhookThresholds;
  payloadFormat?: SharedWebhookPayloadFormat;
}

export interface TestWebhookResponse {
  success: boolean;
  statusCode?: number;
  responseBody?: string;
  error?: string;
  durationMs: number;
  payloadFormat?: SharedWebhookPayloadFormat;
  renderedPayload?: Record<string, unknown>;
}
