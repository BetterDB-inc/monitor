import { Test, TestingModule } from '@nestjs/testing';
import { WebhookDispatcherService } from '../webhook-dispatcher.service';
import { WebhooksService } from '../webhooks.service';
import { StoragePort } from '../../common/interfaces/storage-port.interface';
import {
  WebhookEventType,
  DeliveryStatus,
  WebhookPayloadFormat,
  getDeliveryConfig,
  type WebhookPayload,
} from '@betterdb/shared';
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
    } as unknown as jest.Mocked<WebhooksService>;

    storageClient = {
      createDelivery: jest.fn(),
      getDelivery: jest.fn(),
      updateDelivery: jest.fn(),
    } as unknown as jest.Mocked<StoragePort>;

    configService = {
      get: jest.fn((key: string) => {
        if (key === 'database.host') return 'localhost';
        if (key === 'database.port') return 6379;
        return undefined;
      }),
    } as unknown as jest.Mocked<ConfigService>;

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
        payload: {} as unknown as WebhookPayload,
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

      expect(webhooksService.getWebhooksByEvent).toHaveBeenCalledWith(WebhookEventType.MEMORY_CRITICAL, undefined);
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

    it('should return true on the alert edge and false while parked above threshold', async () => {
      webhooksService.getWebhooksByEvent.mockResolvedValue([]);

      const first = await service.dispatchThresholdAlert(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_edge',
        95,
        90,
        true,
        { message: 'Memory critical' }
      );
      const repeat = await service.dispatchThresholdAlert(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_edge',
        95,
        90,
        true,
        { message: 'Memory critical' }
      );

      expect(first).toBe(true);
      expect(repeat).toBe(false);
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
        payload: {} as unknown as WebhookPayload,
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

  describe('Test Webhook Preview', () => {
    it('should include renderedPayload when delivery fails', async () => {
      webhooksService.generateSignature.mockReturnValue('test-signature');

      const result = await service.testWebhook({
        id: '1',
        name: 'Unreachable Slack',
        url: 'http://127.0.0.1:1/hook',
        enabled: true,
        events: [WebhookEventType.INSTANCE_DOWN],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
        payloadFormat: WebhookPayloadFormat.SLACK,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      expect(result.success).toBe(false);
      expect(result.payloadFormat).toBe('slack');
      expect(result.renderedPayload).toMatchObject({
        text: expect.any(String),
        blocks: expect.any(Array),
      });
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
        payload: {} as unknown as WebhookPayload,
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
        payload: {} as unknown as WebhookPayload,
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
        payload: {} as unknown as WebhookPayload,
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
        payload: {} as unknown as WebhookPayload,
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
        payload: {} as unknown as WebhookPayload,
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

  describe('Storage failure retry buffer', () => {
    const storageError = new Error('storage unavailable');

    const makeWebhook = (id: string) => ({
      id,
      name: `Webhook ${id}`,
      url: `https://example.com/${id}`,
      enabled: true,
      events: [WebhookEventType.INSTANCE_DOWN, WebhookEventType.INSTANCE_UP],
      headers: {},
      retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const deliveryFor = (input: Parameters<StoragePort['createDelivery']>[0]) => ({
      ...input,
      id: `delivery-${input.webhookId}-${(input.payload as WebhookPayload).id}`,
      createdAt: Date.now(),
    });

    let sendWebhook: jest.SpyInstance;

    beforeEach(() => {
      jest.useFakeTimers();
      storageClient.getDeliveriesByWebhook = jest.fn().mockResolvedValue([]);
      storageClient.createDelivery.mockImplementation(async (input) => deliveryFor(input));
      sendWebhook = jest.spyOn(service, 'sendWebhook').mockResolvedValue(DeliveryStatus.SUCCESS);
    });

    afterEach(() => {
      service.onModuleDestroy();
      jest.useRealTimers();
    });

    it('buffers the event when the webhook lookup fails and delivers it once after recovery', async () => {
      webhooksService.getWebhooksByEvent
        .mockRejectedValueOnce(storageError)
        .mockResolvedValue([makeWebhook('a')]);

      const accepted = await service.dispatchEvent(
        WebhookEventType.INSTANCE_DOWN,
        { reason: 'timeout' },
        'conn-1',
      );

      expect(accepted).toBe(true);
      expect(storageClient.createDelivery).not.toHaveBeenCalled();
      expect(service.getStorageRetryBufferStats()).toEqual({ bufferedEvents: 1, droppedEvents: 0 });

      await jest.advanceTimersByTimeAsync(1_000);

      expect(storageClient.createDelivery).toHaveBeenCalledTimes(1);
      expect(storageClient.createDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          webhookId: 'a',
          connectionId: 'conn-1',
          payload: expect.objectContaining({
            event: WebhookEventType.INSTANCE_DOWN,
            data: { reason: 'timeout', connectionId: 'conn-1' },
          }),
        }),
      );
      expect(sendWebhook).toHaveBeenCalledTimes(1);
      expect(service.getStorageRetryBufferStats()).toEqual({ bufferedEvents: 0, droppedEvents: 0 });

      await jest.advanceTimersByTimeAsync(120_000);
      expect(sendWebhook).toHaveBeenCalledTimes(1);
    });

    it('retries a failed createDelivery with the same payload and delivers it once', async () => {
      webhooksService.getWebhooksByEvent.mockResolvedValue([makeWebhook('a')]);
      storageClient.createDelivery
        .mockRejectedValueOnce(storageError)
        .mockImplementation(async (input) => deliveryFor(input));

      const accepted = await service.dispatchEvent(WebhookEventType.INSTANCE_DOWN, {});

      expect(accepted).toBe(true);
      expect(sendWebhook).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1_000);

      expect(storageClient.getDeliveriesByWebhook).toHaveBeenCalledWith('a', expect.any(Number));
      expect(storageClient.createDelivery).toHaveBeenCalledTimes(2);
      const firstPayload = storageClient.createDelivery.mock.calls[0][0].payload;
      const secondPayload = storageClient.createDelivery.mock.calls[1][0].payload;
      expect(secondPayload.id).toBe(firstPayload.id);
      expect(secondPayload.timestamp).toBe(firstPayload.timestamp);
      expect(sendWebhook).toHaveBeenCalledTimes(1);
    });

    it('does not create a second delivery row when the failed createDelivery was in fact written', async () => {
      webhooksService.getWebhooksByEvent.mockResolvedValue([makeWebhook('a')]);
      let written: ReturnType<typeof deliveryFor> | undefined;
      storageClient.createDelivery.mockImplementationOnce(async (input) => {
        written = deliveryFor(input);
        throw storageError;
      });
      (storageClient.getDeliveriesByWebhook as jest.Mock).mockImplementation(async () =>
        written ? [written] : [],
      );

      await service.dispatchEvent(WebhookEventType.INSTANCE_DOWN, {});
      await jest.advanceTimersByTimeAsync(1_000);

      expect(storageClient.createDelivery).toHaveBeenCalledTimes(1);
      expect(sendWebhook).toHaveBeenCalledTimes(1);
      expect(sendWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'a' }),
        written!.id,
        written!.payload,
      );
      expect(service.getStorageRetryBufferStats().bufferedEvents).toBe(0);
    });

    it('does not resend a written delivery the retry processor already picked up', async () => {
      webhooksService.getWebhooksByEvent.mockResolvedValue([makeWebhook('a')]);
      let written: ReturnType<typeof deliveryFor> | undefined;
      storageClient.createDelivery.mockImplementationOnce(async (input) => {
        written = deliveryFor(input);
        throw storageError;
      });
      (storageClient.getDeliveriesByWebhook as jest.Mock).mockImplementation(async () =>
        written ? [{ ...written, status: DeliveryStatus.RETRYING, attempts: 1 }] : [],
      );

      await service.dispatchEvent(WebhookEventType.INSTANCE_DOWN, {});
      await jest.advanceTimersByTimeAsync(1_000);

      expect(storageClient.createDelivery).toHaveBeenCalledTimes(1);
      expect(sendWebhook).not.toHaveBeenCalled();
      expect(service.getStorageRetryBufferStats().bufferedEvents).toBe(0);
    });

    it('retries only the webhooks whose delivery row was not written', async () => {
      webhooksService.getWebhooksByEvent.mockResolvedValue([makeWebhook('a'), makeWebhook('b')]);
      storageClient.createDelivery.mockImplementation(async (input) => {
        if (input.webhookId === 'b' && storageClient.createDelivery.mock.calls.length <= 2) {
          throw storageError;
        }
        return deliveryFor(input);
      });

      const accepted = await service.dispatchEvent(WebhookEventType.INSTANCE_DOWN, {});
      expect(accepted).toBe(true);
      expect(sendWebhook).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1_000);

      const sentTo = sendWebhook.mock.calls.map(([webhook]) => webhook.id);
      expect(sentTo).toEqual(['a', 'b']);
      expect(service.getStorageRetryBufferStats().bufferedEvents).toBe(0);
    });

    it('backs off exponentially between retries and caps the delay', async () => {
      webhooksService.getWebhooksByEvent.mockRejectedValue(storageError);

      await service.dispatchEvent(WebhookEventType.INSTANCE_DOWN, {});
      expect(webhooksService.getWebhooksByEvent).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(999);
      expect(webhooksService.getWebhooksByEvent).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(webhooksService.getWebhooksByEvent).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(webhooksService.getWebhooksByEvent).toHaveBeenCalledTimes(3);
      await jest.advanceTimersByTimeAsync(4_000);
      expect(webhooksService.getWebhooksByEvent).toHaveBeenCalledTimes(4);

      await jest.advanceTimersByTimeAsync(8_000 + 16_000 + 32_000);
      expect(webhooksService.getWebhooksByEvent).toHaveBeenCalledTimes(7);
      await jest.advanceTimersByTimeAsync(59_999);
      expect(webhooksService.getWebhooksByEvent).toHaveBeenCalledTimes(7);
      await jest.advanceTimersByTimeAsync(1);
      expect(webhooksService.getWebhooksByEvent).toHaveBeenCalledTimes(8);
    });

    it('queues later events behind buffered ones and delivers them in order', async () => {
      webhooksService.getWebhooksByEvent
        .mockRejectedValueOnce(storageError)
        .mockResolvedValue([makeWebhook('a')]);

      await service.dispatchEvent(WebhookEventType.INSTANCE_DOWN, {});
      const accepted = await service.dispatchEvent(WebhookEventType.INSTANCE_UP, {});

      expect(accepted).toBe(true);
      expect(webhooksService.getWebhooksByEvent).toHaveBeenCalledTimes(1);
      expect(service.getStorageRetryBufferStats().bufferedEvents).toBe(2);

      await jest.advanceTimersByTimeAsync(1_000);

      const events = sendWebhook.mock.calls.map(([, , payload]) => payload.event);
      expect(events).toEqual([WebhookEventType.INSTANCE_DOWN, WebhookEventType.INSTANCE_UP]);
    });

    it('waits for a direct dispatch already in flight before flushing later buffered events', async () => {
      let resolveFirstLookup: (webhooks: ReturnType<typeof makeWebhook>[]) => void = () => {};
      webhooksService.getWebhooksByEvent
        .mockImplementationOnce(
          () => new Promise((resolve) => (resolveFirstLookup = resolve)),
        )
        .mockRejectedValueOnce(storageError)
        .mockResolvedValue([makeWebhook('a')]);
      storageClient.createDelivery
        .mockRejectedValueOnce(storageError)
        .mockImplementation(async (input) => deliveryFor(input));

      const first = service.dispatchEvent(WebhookEventType.INSTANCE_DOWN, {});
      await service.dispatchEvent(WebhookEventType.INSTANCE_UP, {});

      await jest.advanceTimersByTimeAsync(1_000);
      expect(sendWebhook).not.toHaveBeenCalled();

      resolveFirstLookup([makeWebhook('a')]);
      await first;
      await jest.advanceTimersByTimeAsync(1_000);

      const events = sendWebhook.mock.calls.map(([, , payload]) => payload.event);
      expect(events).toEqual([WebhookEventType.INSTANCE_DOWN, WebhookEventType.INSTANCE_UP]);
      expect(service.getStorageRetryBufferStats().bufferedEvents).toBe(0);
    });

    it('drops the oldest buffered event when the buffer is full', async () => {
      webhooksService.getWebhooksByEvent.mockRejectedValue(storageError);

      for (let seq = 0; seq <= 1000; seq++) {
        await service.dispatchEvent(WebhookEventType.INSTANCE_DOWN, { seq });
      }

      expect(service.getStorageRetryBufferStats()).toEqual({
        bufferedEvents: 1000,
        droppedEvents: 1,
      });

      webhooksService.getWebhooksByEvent.mockResolvedValue([makeWebhook('a')]);
      await jest.advanceTimersByTimeAsync(1_000);

      const sequences = sendWebhook.mock.calls.map(([, , payload]) => payload.data.seq);
      expect(sequences).toHaveLength(1000);
      expect(sequences[0]).toBe(1);
      expect(sequences[999]).toBe(1000);
    });

    it('clears the retry timer and buffer on module destroy', async () => {
      webhooksService.getWebhooksByEvent.mockRejectedValue(storageError);

      await service.dispatchEvent(WebhookEventType.INSTANCE_DOWN, {});
      expect(jest.getTimerCount()).toBe(1);

      service.onModuleDestroy();

      expect(jest.getTimerCount()).toBe(0);
      expect(service.getStorageRetryBufferStats().bufferedEvents).toBe(0);
      await jest.advanceTimersByTimeAsync(120_000);
      expect(webhooksService.getWebhooksByEvent).toHaveBeenCalledTimes(1);
    });

    it('reports a terminal failure when storage fails after shutdown', async () => {
      webhooksService.getWebhooksByEvent.mockRejectedValue(storageError);
      service.onModuleDestroy();

      const accepted = await service.dispatchEvent(WebhookEventType.INSTANCE_DOWN, {});

      expect(accepted).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('still reports terminal delivery failures as not accepted', async () => {
      webhooksService.getWebhooksByEvent.mockResolvedValue([makeWebhook('a')]);
      sendWebhook.mockResolvedValue(DeliveryStatus.FAILED);

      const accepted = await service.dispatchEvent(WebhookEventType.INSTANCE_DOWN, {});

      expect(accepted).toBe(false);
      expect(service.getStorageRetryBufferStats().bufferedEvents).toBe(0);
    });

    it('buffers a per-webhook threshold alert whose delivery row could not be written', async () => {
      webhooksService.getWebhooksByEvent.mockResolvedValue([
        { ...makeWebhook('a'), events: [WebhookEventType.MEMORY_CRITICAL] },
      ]);
      storageClient.createDelivery
        .mockRejectedValueOnce(storageError)
        .mockImplementation(async (input) => deliveryFor(input));

      await service.dispatchThresholdAlertPerWebhook(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_buffer_test',
        95,
        'memoryCriticalPercent',
        true,
        { usedPercent: 95 },
      );
      expect(sendWebhook).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1_000);

      expect(sendWebhook).toHaveBeenCalledTimes(1);
      expect(sendWebhook.mock.calls[0][2].data).toEqual(
        expect.objectContaining({ usedPercent: 95, thresholdKey: 'memoryCriticalPercent' }),
      );
    });
  });
});
