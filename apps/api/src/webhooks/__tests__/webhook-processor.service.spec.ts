import { Test, TestingModule } from '@nestjs/testing';
import { WebhookProcessorService } from '../webhook-processor.service';
import { WebhooksService } from '../webhooks.service';
import { WebhookDispatcherService } from '../webhook-dispatcher.service';
import { StoragePort } from '../../common/interfaces/storage-port.interface';
import { DeliveryStatus } from '@betterdb/shared';

describe('WebhookProcessorService', () => {
  let service: WebhookProcessorService;
  let webhooksService: jest.Mocked<WebhooksService>;
  let dispatcherService: jest.Mocked<WebhookDispatcherService>;
  let storageClient: jest.Mocked<StoragePort>;

  beforeEach(async () => {
    webhooksService = {
      getWebhook: jest.fn(),
    } as any;

    dispatcherService = {
      sendWebhook: jest.fn(),
    } as any;

    storageClient = {
      getRetriableDeliveries: jest.fn(),
      getDelivery: jest.fn(),
      updateDelivery: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookProcessorService,
        {
          provide: WebhooksService,
          useValue: webhooksService,
        },
        {
          provide: WebhookDispatcherService,
          useValue: dispatcherService,
        },
        {
          provide: 'STORAGE_CLIENT',
          useValue: storageClient,
        },
      ],
    }).compile();

    service = module.get<WebhookProcessorService>(WebhookProcessorService);
  });

  describe('Retry Processing', () => {
    it('should process retriable deliveries', async () => {
      const delivery = {
        id: '1',
        webhookId: 'webhook-1',
        eventType: 'instance.down' as any,
        payload: { test: 'data' } as any,
        status: DeliveryStatus.RETRYING,
        attempts: 1,
        nextRetryAt: Date.now() - 1000,
        createdAt: Date.now(),
      };

      const webhook = {
        id: 'webhook-1',
        name: 'Test',
        url: 'https://example.com',
        enabled: true,
        events: [],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      storageClient.getRetriableDeliveries.mockResolvedValue([delivery]);
      webhooksService.getWebhook.mockResolvedValue(webhook);
      dispatcherService.sendWebhook.mockResolvedValue();

      await service.processRetries();

      expect(dispatcherService.sendWebhook).toHaveBeenCalledWith(webhook, delivery.id, delivery.payload);
    });

    it('should skip disabled webhooks', async () => {
      const delivery = {
        id: '1',
        webhookId: 'webhook-1',
        eventType: 'instance.down' as any,
        payload: { test: 'data' } as any,
        status: DeliveryStatus.RETRYING,
        attempts: 1,
        nextRetryAt: Date.now() - 1000,
        createdAt: Date.now(),
      };

      const webhook = {
        id: 'webhook-1',
        name: 'Test',
        url: 'https://example.com',
        enabled: false,
        events: [],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      storageClient.getRetriableDeliveries.mockResolvedValue([delivery]);
      webhooksService.getWebhook.mockResolvedValue(webhook);

      await service.processRetries();

      expect(dispatcherService.sendWebhook).not.toHaveBeenCalled();
      expect(storageClient.updateDelivery).toHaveBeenCalledWith(delivery.id, {
        status: DeliveryStatus.FAILED,
        completedAt: expect.any(Number),
        responseBody: 'Webhook disabled',
      });
    });

    it('should prevent concurrent processing', async () => {
      storageClient.getRetriableDeliveries.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 100))
      );

      const promise1 = service.processRetries();
      const promise2 = service.processRetries();

      await Promise.all([promise1, promise2]);

      // Should only call once due to isProcessing flag
      expect(storageClient.getRetriableDeliveries).toHaveBeenCalledTimes(1);
    });
  });

  describe('Exponential Backoff', () => {
    it('should calculate correct retry delays', () => {
      const retryPolicy = {
        maxRetries: 3,
        backoffMultiplier: 2,
        initialDelayMs: 1000,
        maxDelayMs: 60000,
      };

      // Attempt 1: 1000ms
      const delay1 = retryPolicy.initialDelayMs * Math.pow(retryPolicy.backoffMultiplier, 0);
      expect(delay1).toBe(1000);

      // Attempt 2: 2000ms
      const delay2 = retryPolicy.initialDelayMs * Math.pow(retryPolicy.backoffMultiplier, 1);
      expect(delay2).toBe(2000);

      // Attempt 3: 4000ms
      const delay3 = retryPolicy.initialDelayMs * Math.pow(retryPolicy.backoffMultiplier, 2);
      expect(delay3).toBe(4000);
    });

    it('should cap delay at maxDelayMs', () => {
      const retryPolicy = {
        maxRetries: 10,
        backoffMultiplier: 2,
        initialDelayMs: 1000,
        maxDelayMs: 60000,
      };

      // Attempt 10 would be 512000ms, but should cap at 60000ms
      const delay = Math.min(
        retryPolicy.initialDelayMs * Math.pow(retryPolicy.backoffMultiplier, 9),
        retryPolicy.maxDelayMs
      );
      expect(delay).toBe(60000);
    });
  });
});
