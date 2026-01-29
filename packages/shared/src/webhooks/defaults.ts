import type {
  Webhook,
  WebhookDeliveryConfig,
  WebhookAlertConfig,
  WebhookThresholds,
} from './types';

/**
 * Default delivery configuration values
 */
export const DEFAULT_DELIVERY_CONFIG: Required<WebhookDeliveryConfig> = {
  timeoutMs: 30000,
  maxResponseBodyBytes: 10000,
};

/**
 * Default alert configuration values
 */
export const DEFAULT_ALERT_CONFIG: Required<WebhookAlertConfig> = {
  hysteresisFactor: 0.9,
};

/**
 * Default threshold values
 */
export const DEFAULT_THRESHOLDS: Required<WebhookThresholds> = {
  memoryCriticalPercent: 90,
  connectionCriticalPercent: 90,
  complianceMemoryPercent: 80,
  slowlogCount: 100,
  replicationLagSeconds: 10,
  latencySpikeMs: 0,
  connectionSpikeCount: 0,
};

/**
 * Get the effective delivery config for a webhook, merging with defaults
 */
export function getDeliveryConfig(webhook: Webhook): Required<WebhookDeliveryConfig> {
  return {
    ...DEFAULT_DELIVERY_CONFIG,
    ...webhook.deliveryConfig,
  };
}

/**
 * Get the effective alert config for a webhook, merging with defaults
 */
export function getAlertConfig(webhook: Webhook): Required<WebhookAlertConfig> {
  return {
    ...DEFAULT_ALERT_CONFIG,
    ...webhook.alertConfig,
  };
}

/**
 * Get the effective thresholds for a webhook, merging with defaults
 */
export function getThresholds(webhook: Webhook): Required<WebhookThresholds> {
  return {
    ...DEFAULT_THRESHOLDS,
    ...webhook.thresholds,
  };
}

/**
 * Get a specific threshold value for a webhook
 */
export function getThreshold(
  webhook: Webhook,
  key: keyof WebhookThresholds,
): number {
  return getThresholds(webhook)[key];
}
