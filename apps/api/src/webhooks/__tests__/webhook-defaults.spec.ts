import {
  DEFAULT_DELIVERY_CONFIG,
  DEFAULT_ALERT_CONFIG,
  DEFAULT_THRESHOLDS,
  getDeliveryConfig,
  getAlertConfig,
  getThresholds,
  getThreshold,
} from '@betterdb/shared';
import type { Webhook } from '@betterdb/shared';

describe('Webhook Defaults', () => {
  const baseWebhook: Webhook = {
    id: 'test-id',
    name: 'Test Webhook',
    url: 'https://example.com/hook',
    secret: 'test-secret',
    enabled: true,
    events: [],
    headers: {},
    retryPolicy: {
      maxRetries: 3,
      backoffMultiplier: 2,
      initialDelayMs: 1000,
      maxDelayMs: 60000,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  describe('DEFAULT_DELIVERY_CONFIG', () => {
    it('should have correct default values', () => {
      expect(DEFAULT_DELIVERY_CONFIG.timeoutMs).toBe(30000);
      expect(DEFAULT_DELIVERY_CONFIG.maxResponseBodyBytes).toBe(10000);
    });
  });

  describe('DEFAULT_ALERT_CONFIG', () => {
    it('should have correct default hysteresis factor', () => {
      expect(DEFAULT_ALERT_CONFIG.hysteresisFactor).toBe(0.9);
    });
  });

  describe('DEFAULT_THRESHOLDS', () => {
    it('should have correct default threshold values', () => {
      expect(DEFAULT_THRESHOLDS.memoryCriticalPercent).toBe(90);
      expect(DEFAULT_THRESHOLDS.connectionCriticalPercent).toBe(90);
      expect(DEFAULT_THRESHOLDS.complianceMemoryPercent).toBe(80);
      expect(DEFAULT_THRESHOLDS.slowlogCount).toBe(100);
      expect(DEFAULT_THRESHOLDS.replicationLagSeconds).toBe(10);
      expect(DEFAULT_THRESHOLDS.latencySpikeMs).toBe(0);
      expect(DEFAULT_THRESHOLDS.connectionSpikeCount).toBe(0);
    });
  });

  describe('getDeliveryConfig', () => {
    it('should return default values when webhook has no deliveryConfig', () => {
      const config = getDeliveryConfig(baseWebhook);

      expect(config.timeoutMs).toBe(30000);
      expect(config.maxResponseBodyBytes).toBe(10000);
    });

    it('should return default values when deliveryConfig is undefined', () => {
      const webhook: Webhook = {
        ...baseWebhook,
        deliveryConfig: undefined,
      };

      const config = getDeliveryConfig(webhook);

      expect(config.timeoutMs).toBe(30000);
      expect(config.maxResponseBodyBytes).toBe(10000);
    });

    it('should merge custom timeoutMs with defaults', () => {
      const webhook: Webhook = {
        ...baseWebhook,
        deliveryConfig: { timeoutMs: 5000 },
      };

      const config = getDeliveryConfig(webhook);

      expect(config.timeoutMs).toBe(5000);
      expect(config.maxResponseBodyBytes).toBe(10000);
    });

    it('should merge custom maxResponseBodyBytes with defaults', () => {
      const webhook: Webhook = {
        ...baseWebhook,
        deliveryConfig: { maxResponseBodyBytes: 50000 },
      };

      const config = getDeliveryConfig(webhook);

      expect(config.timeoutMs).toBe(30000);
      expect(config.maxResponseBodyBytes).toBe(50000);
    });

    it('should use all custom values when provided', () => {
      const webhook: Webhook = {
        ...baseWebhook,
        deliveryConfig: {
          timeoutMs: 15000,
          maxResponseBodyBytes: 25000,
        },
      };

      const config = getDeliveryConfig(webhook);

      expect(config.timeoutMs).toBe(15000);
      expect(config.maxResponseBodyBytes).toBe(25000);
    });
  });

  describe('getAlertConfig', () => {
    it('should return default values when webhook has no alertConfig', () => {
      const config = getAlertConfig(baseWebhook);

      expect(config.hysteresisFactor).toBe(0.9);
    });

    it('should return default values when alertConfig is undefined', () => {
      const webhook: Webhook = {
        ...baseWebhook,
        alertConfig: undefined,
      };

      const config = getAlertConfig(webhook);

      expect(config.hysteresisFactor).toBe(0.9);
    });

    it('should use custom hysteresis factor when provided', () => {
      const webhook: Webhook = {
        ...baseWebhook,
        alertConfig: { hysteresisFactor: 0.8 },
      };

      const config = getAlertConfig(webhook);

      expect(config.hysteresisFactor).toBe(0.8);
    });

    it('should handle edge case hysteresis values', () => {
      const webhookLow: Webhook = {
        ...baseWebhook,
        alertConfig: { hysteresisFactor: 0.5 },
      };

      const webhookHigh: Webhook = {
        ...baseWebhook,
        alertConfig: { hysteresisFactor: 0.99 },
      };

      expect(getAlertConfig(webhookLow).hysteresisFactor).toBe(0.5);
      expect(getAlertConfig(webhookHigh).hysteresisFactor).toBe(0.99);
    });
  });

  describe('getThresholds', () => {
    it('should return all default values when webhook has no thresholds', () => {
      const thresholds = getThresholds(baseWebhook);

      expect(thresholds.memoryCriticalPercent).toBe(90);
      expect(thresholds.connectionCriticalPercent).toBe(90);
      expect(thresholds.complianceMemoryPercent).toBe(80);
      expect(thresholds.slowlogCount).toBe(100);
      expect(thresholds.replicationLagSeconds).toBe(10);
      expect(thresholds.latencySpikeMs).toBe(0);
      expect(thresholds.connectionSpikeCount).toBe(0);
    });

    it('should return default values when thresholds is undefined', () => {
      const webhook: Webhook = {
        ...baseWebhook,
        thresholds: undefined,
      };

      const thresholds = getThresholds(webhook);

      expect(thresholds.memoryCriticalPercent).toBe(90);
    });

    it('should merge single custom threshold with defaults', () => {
      const webhook: Webhook = {
        ...baseWebhook,
        thresholds: { memoryCriticalPercent: 75 },
      };

      const thresholds = getThresholds(webhook);

      expect(thresholds.memoryCriticalPercent).toBe(75);
      expect(thresholds.connectionCriticalPercent).toBe(90);
      expect(thresholds.complianceMemoryPercent).toBe(80);
    });

    it('should merge multiple custom thresholds with defaults', () => {
      const webhook: Webhook = {
        ...baseWebhook,
        thresholds: {
          memoryCriticalPercent: 70,
          connectionCriticalPercent: 85,
          slowlogCount: 50,
        },
      };

      const thresholds = getThresholds(webhook);

      expect(thresholds.memoryCriticalPercent).toBe(70);
      expect(thresholds.connectionCriticalPercent).toBe(85);
      expect(thresholds.slowlogCount).toBe(50);
      expect(thresholds.complianceMemoryPercent).toBe(80);
      expect(thresholds.replicationLagSeconds).toBe(10);
    });

    it('should use all custom values when provided', () => {
      const webhook: Webhook = {
        ...baseWebhook,
        thresholds: {
          memoryCriticalPercent: 95,
          connectionCriticalPercent: 95,
          complianceMemoryPercent: 90,
          slowlogCount: 200,
          replicationLagSeconds: 30,
          latencySpikeMs: 100,
          connectionSpikeCount: 500,
        },
      };

      const thresholds = getThresholds(webhook);

      expect(thresholds.memoryCriticalPercent).toBe(95);
      expect(thresholds.connectionCriticalPercent).toBe(95);
      expect(thresholds.complianceMemoryPercent).toBe(90);
      expect(thresholds.slowlogCount).toBe(200);
      expect(thresholds.replicationLagSeconds).toBe(30);
      expect(thresholds.latencySpikeMs).toBe(100);
      expect(thresholds.connectionSpikeCount).toBe(500);
    });
  });

  describe('getThreshold', () => {
    it('should return default value for specific threshold key', () => {
      expect(getThreshold(baseWebhook, 'memoryCriticalPercent')).toBe(90);
      expect(getThreshold(baseWebhook, 'connectionCriticalPercent')).toBe(90);
      expect(getThreshold(baseWebhook, 'slowlogCount')).toBe(100);
    });

    it('should return custom value when set', () => {
      const webhook: Webhook = {
        ...baseWebhook,
        thresholds: { memoryCriticalPercent: 75 },
      };

      expect(getThreshold(webhook, 'memoryCriticalPercent')).toBe(75);
    });

    it('should return default for unset key even when other keys are set', () => {
      const webhook: Webhook = {
        ...baseWebhook,
        thresholds: { memoryCriticalPercent: 75 },
      };

      expect(getThreshold(webhook, 'connectionCriticalPercent')).toBe(90);
    });

    it('should work with all threshold keys', () => {
      const webhook: Webhook = {
        ...baseWebhook,
        thresholds: {
          memoryCriticalPercent: 80,
          connectionCriticalPercent: 85,
          complianceMemoryPercent: 70,
          slowlogCount: 150,
          replicationLagSeconds: 5,
          latencySpikeMs: 50,
          connectionSpikeCount: 100,
        },
      };

      expect(getThreshold(webhook, 'memoryCriticalPercent')).toBe(80);
      expect(getThreshold(webhook, 'connectionCriticalPercent')).toBe(85);
      expect(getThreshold(webhook, 'complianceMemoryPercent')).toBe(70);
      expect(getThreshold(webhook, 'slowlogCount')).toBe(150);
      expect(getThreshold(webhook, 'replicationLagSeconds')).toBe(5);
      expect(getThreshold(webhook, 'latencySpikeMs')).toBe(50);
      expect(getThreshold(webhook, 'connectionSpikeCount')).toBe(100);
    });
  });

  describe('Edge Cases', () => {
    it('should handle webhook with empty config objects', () => {
      const webhook: Webhook = {
        ...baseWebhook,
        deliveryConfig: {},
        alertConfig: {},
        thresholds: {},
      };

      expect(getDeliveryConfig(webhook).timeoutMs).toBe(30000);
      expect(getAlertConfig(webhook).hysteresisFactor).toBe(0.9);
      expect(getThresholds(webhook).memoryCriticalPercent).toBe(90);
    });

    it('should handle zero values correctly (not treat as falsy)', () => {
      const webhook: Webhook = {
        ...baseWebhook,
        thresholds: {
          latencySpikeMs: 0,
          connectionSpikeCount: 0,
        },
      };

      // 0 should be preserved, not replaced with default
      expect(getThreshold(webhook, 'latencySpikeMs')).toBe(0);
      expect(getThreshold(webhook, 'connectionSpikeCount')).toBe(0);
    });

    it('should not mutate original webhook', () => {
      const webhook: Webhook = {
        ...baseWebhook,
        deliveryConfig: { timeoutMs: 5000 },
      };

      const originalConfig = { ...webhook.deliveryConfig };
      getDeliveryConfig(webhook);

      expect(webhook.deliveryConfig).toEqual(originalConfig);
    });
  });
});
