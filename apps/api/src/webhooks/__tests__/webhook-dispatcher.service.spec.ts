import { Test, TestingModule } from '@nestjs/testing';
import { WebhookDispatcherService } from '../webhook-dispatcher.service';
import { WebhooksService } from '../webhooks.service';
import { StoragePort } from '../../common/interfaces/storage-port.interface';
import { WebhookEventType, DeliveryStatus } from '@betterdb/shared';
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
});
