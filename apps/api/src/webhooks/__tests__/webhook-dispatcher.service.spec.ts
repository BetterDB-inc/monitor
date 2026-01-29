import { Test, TestingModule } from '@nestjs/testing';
import { WebhookDispatcherService } from '../webhook-dispatcher.service';
import { WebhooksService } from '../webhooks.service';
import { StoragePort } from '../../common/interfaces/storage-port.interface';
import { WebhookEventType, DeliveryStatus, getDeliveryConfig } from '@betterdb/shared';
import { ConfigService } from '@nestjs/config';

describe('WebhookDispatcherService', () => {
  let service: WebhookDispatcherService;
  let webhooksService: jest.Mocked<WebhooksService>;
  let storageClient: jest.Mocked<StoragePort>;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    webhooksService = {
      getWebhooksByEvent: jest.fn(),
      generateSignature: jest.fn(),
    } as any;

    storageClient = {
      createDelivery: jest.fn(),
      getDelivery: jest.fn(),
      updateDelivery: jest.fn(),
    } as any;

    configService = {
      get: jest.fn((key: string) => {
        if (key === 'database.host') return 'localhost';
        if (key === 'database.port') return 6379;
        return undefined;
      }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDispatcherService,
        {
          provide: WebhooksService,
          useValue: webhooksService,
        },
        {
          provide: 'STORAGE_CLIENT',
          useValue: storageClient,
        },
        {
          provide: ConfigService,
          useValue: configService,
        },
      ],
    }).compile();

    service = module.get<WebhookDispatcherService>(WebhookDispatcherService);
  });

  describe('Threshold Alert Hysteresis', () => {
    it('should fire alert when threshold first exceeded', async () => {
      webhooksService.getWebhooksByEvent.mockResolvedValue([
        {
          id: '1',
          name: 'Test',
          url: 'https://example.com',
          enabled: true,
          events: [WebhookEventType.MEMORY_CRITICAL],
          headers: {},
          retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]);

      storageClient.createDelivery.mockResolvedValue({
        id: 'delivery-1',
        webhookId: '1',
        eventType: WebhookEventType.MEMORY_CRITICAL,
        payload: {} as any,
        status: DeliveryStatus.PENDING,
        attempts: 0,
        createdAt: Date.now(),
      });

      await service.dispatchThresholdAlert(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_test',
        95,
        90,
        true,
        { message: 'Memory critical' }
      );

      expect(webhooksService.getWebhooksByEvent).toHaveBeenCalledWith(WebhookEventType.MEMORY_CRITICAL);
    });

    it('should not re-fire alert while threshold still exceeded', async () => {
      webhooksService.getWebhooksByEvent.mockResolvedValue([]);

      // First trigger
      await service.dispatchThresholdAlert(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_test',
        95,
        90,
        true,
        { message: 'Memory critical' }
      );

      webhooksService.getWebhooksByEvent.mockClear();

      // Second trigger - should not fire
      await service.dispatchThresholdAlert(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_test',
        93,
        90,
        true,
        { message: 'Memory critical' }
      );

      expect(webhooksService.getWebhooksByEvent).not.toHaveBeenCalled();
    });

    it('should clear alert state after recovery (10% hysteresis)', async () => {
      webhooksService.getWebhooksByEvent.mockResolvedValue([
        {
          id: '1',
          name: 'Test',
          url: 'https://example.com',
          enabled: true,
          events: [WebhookEventType.MEMORY_CRITICAL],
          headers: {},
          retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]);

      storageClient.createDelivery.mockResolvedValue({
        id: 'delivery-1',
        webhookId: '1',
        eventType: WebhookEventType.MEMORY_CRITICAL,
        payload: {} as any,
        status: DeliveryStatus.PENDING,
        attempts: 0,
        createdAt: Date.now(),
      });

      // Fire alert at 95%
      await service.dispatchThresholdAlert(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_test',
        95,
        90,
        true,
        { message: 'Memory critical' }
      );

      webhooksService.getWebhooksByEvent.mockClear();

      // Drop to 89% (still above 81% recovery threshold) - should not clear
      await service.dispatchThresholdAlert(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_test',
        89,
        90,
        true,
        { message: 'Memory critical' }
      );

      expect(webhooksService.getWebhooksByEvent).not.toHaveBeenCalled();

      // Drop to 80% (below 81% recovery threshold) - should clear
      await service.dispatchThresholdAlert(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_test',
        80,
        90,
        true,
        { message: 'Memory critical' }
      );

      // Now can fire again at 92%
      await service.dispatchThresholdAlert(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_test',
        92,
        90,
        true,
        { message: 'Memory critical' }
      );

      expect(webhooksService.getWebhooksByEvent).toHaveBeenCalled();
    });
  });

  describe('Signature Generation', () => {
    it('should generate signature with timestamp', () => {
      webhooksService.generateSignature.mockReturnValue('test-signature');
      const payload = { test: 'data' };
      const secret = 'test-secret';

      const result = service.generateSignatureWithTimestamp(JSON.stringify(payload), secret, Date.now());

      expect(webhooksService.generateSignature).toHaveBeenCalled();
      expect(result).toBe('test-signature');
    });
  });

  describe('Per-Webhook Threshold Alerts', () => {
    it('should use per-webhook threshold when configured', async () => {
      const webhook = {
        id: '1',
        name: 'Custom Threshold',
        url: 'https://example.com',
        enabled: true,
        events: [WebhookEventType.MEMORY_CRITICAL],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
        thresholds: { memoryCriticalPercent: 80 }, // Custom threshold
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      webhooksService.getWebhooksByEvent.mockResolvedValue([webhook]);
      storageClient.createDelivery.mockResolvedValue({
        id: 'delivery-1',
        webhookId: '1',
        eventType: WebhookEventType.MEMORY_CRITICAL,
        payload: {} as any,
        status: DeliveryStatus.PENDING,
        attempts: 0,
        createdAt: Date.now(),
      });

      // 85% should trigger for webhook with 80% threshold
      await service.dispatchThresholdAlertPerWebhook(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_custom_threshold',
        85,
        'memoryCriticalPercent',
        true,
        { message: 'Memory high' }
      );

      expect(storageClient.createDelivery).toHaveBeenCalled();
    });

    it('should not fire when value below per-webhook threshold', async () => {
      const webhook = {
        id: '1',
        name: 'High Threshold',
        url: 'https://example.com',
        enabled: true,
        events: [WebhookEventType.MEMORY_CRITICAL],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
        thresholds: { memoryCriticalPercent: 95 }, // High threshold
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      webhooksService.getWebhooksByEvent.mockResolvedValue([webhook]);

      // 90% should NOT trigger for webhook with 95% threshold
      await service.dispatchThresholdAlertPerWebhook(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_high_threshold',
        90,
        'memoryCriticalPercent',
        true,
        { message: 'Memory high' }
      );

      expect(storageClient.createDelivery).not.toHaveBeenCalled();
    });

    it('should handle multiple webhooks with different thresholds', async () => {
      const webhookLow = {
        id: '1',
        name: 'Low Threshold',
        url: 'https://example.com/low',
        enabled: true,
        events: [WebhookEventType.MEMORY_CRITICAL],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
        thresholds: { memoryCriticalPercent: 70 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const webhookHigh = {
        id: '2',
        name: 'High Threshold',
        url: 'https://example.com/high',
        enabled: true,
        events: [WebhookEventType.MEMORY_CRITICAL],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
        thresholds: { memoryCriticalPercent: 95 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      webhooksService.getWebhooksByEvent.mockResolvedValue([webhookLow, webhookHigh]);
      storageClient.createDelivery.mockResolvedValue({
        id: 'delivery-1',
        webhookId: '1',
        eventType: WebhookEventType.MEMORY_CRITICAL,
        payload: {} as any,
        status: DeliveryStatus.PENDING,
        attempts: 0,
        createdAt: Date.now(),
      });

      // 80% should trigger LOW (70%) but not HIGH (95%)
      await service.dispatchThresholdAlertPerWebhook(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_multi_webhook',
        80,
        'memoryCriticalPercent',
        true,
        { message: 'Memory high' }
      );

      // Should only create delivery for the low threshold webhook
      expect(storageClient.createDelivery).toHaveBeenCalledTimes(1);
      expect(storageClient.createDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ webhookId: '1' })
      );
    });

    it('should use default threshold when not configured', async () => {
      const webhook = {
        id: '1',
        name: 'Default Threshold',
        url: 'https://example.com',
        enabled: true,
        events: [WebhookEventType.MEMORY_CRITICAL],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
        // No thresholds configured - should use default 90%
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      webhooksService.getWebhooksByEvent.mockResolvedValue([webhook]);
      storageClient.createDelivery.mockResolvedValue({
        id: 'delivery-1',
        webhookId: '1',
        eventType: WebhookEventType.MEMORY_CRITICAL,
        payload: {} as any,
        status: DeliveryStatus.PENDING,
        attempts: 0,
        createdAt: Date.now(),
      });

      // 92% should trigger with default 90% threshold
      await service.dispatchThresholdAlertPerWebhook(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_default_threshold',
        92,
        'memoryCriticalPercent',
        true,
        { message: 'Memory high' }
      );

      expect(storageClient.createDelivery).toHaveBeenCalled();
    });

    it('should use per-webhook hysteresis factor', async () => {
      const webhook = {
        id: '1',
        name: 'Custom Hysteresis',
        url: 'https://example.com',
        enabled: true,
        events: [WebhookEventType.MEMORY_CRITICAL],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
        thresholds: { memoryCriticalPercent: 90 },
        alertConfig: { hysteresisFactor: 0.8 }, // 20% margin instead of 10%
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      webhooksService.getWebhooksByEvent.mockResolvedValue([webhook]);
      storageClient.createDelivery.mockResolvedValue({
        id: 'delivery-1',
        webhookId: '1',
        eventType: WebhookEventType.MEMORY_CRITICAL,
        payload: {} as any,
        status: DeliveryStatus.PENDING,
        attempts: 0,
        createdAt: Date.now(),
      });

      // Fire initial alert
      await service.dispatchThresholdAlertPerWebhook(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_hysteresis_custom',
        95,
        'memoryCriticalPercent',
        true,
        { message: 'Memory high' }
      );

      expect(storageClient.createDelivery).toHaveBeenCalledTimes(1);
      storageClient.createDelivery.mockClear();

      // Drop to 75% - above 72% (90% * 0.8), should NOT clear with custom hysteresis
      // So this should NOT trigger a new alert
      await service.dispatchThresholdAlertPerWebhook(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_hysteresis_custom',
        75,
        'memoryCriticalPercent',
        true,
        { message: 'Memory high' }
      );

      expect(storageClient.createDelivery).not.toHaveBeenCalled();

      // Drop to 70% - below 72%, should clear and allow re-fire
      await service.dispatchThresholdAlertPerWebhook(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_hysteresis_custom',
        70,
        'memoryCriticalPercent',
        true,
        { message: 'Memory high' }
      );

      // Now fire again at 92%
      await service.dispatchThresholdAlertPerWebhook(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_hysteresis_custom',
        92,
        'memoryCriticalPercent',
        true,
        { message: 'Memory high' }
      );

      expect(storageClient.createDelivery).toHaveBeenCalled();
    });

    it('should read per-webhook delivery timeout from config', () => {
      const webhook = {
        id: '1',
        name: 'Fast Timeout',
        url: 'https://example.com',
        enabled: true,
        events: [WebhookEventType.INSTANCE_DOWN],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
        deliveryConfig: { timeoutMs: 5000 }, // 5 second timeout
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const config = getDeliveryConfig(webhook);
      expect(config.timeoutMs).toBe(5000);
    });

    it('should include threshold info in dispatched payload', async () => {
      const webhook = {
        id: '1',
        name: 'Threshold Payload',
        url: 'https://example.com',
        enabled: true,
        events: [WebhookEventType.MEMORY_CRITICAL],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
        thresholds: { memoryCriticalPercent: 75 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      webhooksService.getWebhooksByEvent.mockResolvedValue([webhook]);
      storageClient.createDelivery.mockResolvedValue({
        id: 'delivery-1',
        webhookId: '1',
        eventType: WebhookEventType.MEMORY_CRITICAL,
        payload: {} as any,
        status: DeliveryStatus.PENDING,
        attempts: 0,
        createdAt: Date.now(),
      });

      await service.dispatchThresholdAlertPerWebhook(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_payload_test',
        80,
        'memoryCriticalPercent',
        true,
        { usedPercent: 80 }
      );

      expect(storageClient.createDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            data: expect.objectContaining({
              threshold: 75,
              thresholdKey: 'memoryCriticalPercent',
            }),
          }),
        })
      );
    });
  });
});
