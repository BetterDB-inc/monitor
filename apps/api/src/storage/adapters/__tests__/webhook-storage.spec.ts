import { MemoryAdapter } from '../memory.adapter';
import { StoragePort } from '../../../common/interfaces/storage-port.interface';
import { WebhookEventType, DeliveryStatus } from '@betterdb/shared';

describe('Webhook Storage', () => {
  let adapter: StoragePort;

  beforeEach(async () => {
    adapter = new MemoryAdapter();
    await adapter.initialize();
  });

  afterEach(async () => {
    await adapter.close();
  });

  describe('Webhook CRUD', () => {
    it('should create and retrieve webhook', async () => {
      const webhook = await adapter.createWebhook({
        name: 'Test Webhook',
        url: 'https://example.com/hook',
        secret: 'test-secret',
        enabled: true,
        events: [WebhookEventType.INSTANCE_DOWN],
        headers: { 'X-Custom': 'value' },
        retryPolicy: {
          maxRetries: 3,
          backoffMultiplier: 2,
          initialDelayMs: 1000,
          maxDelayMs: 60000,
        },
      });

      expect(webhook).toMatchObject({
        id: expect.any(String),
        name: 'Test Webhook',
        url: 'https://example.com/hook',
        secret: 'test-secret',
        enabled: true,
        events: [WebhookEventType.INSTANCE_DOWN],
        headers: { 'X-Custom': 'value' },
      });

      const retrieved = await adapter.getWebhook(webhook.id);
      expect(retrieved).toMatchObject(webhook);
    });

    it('should list webhooks by instance', async () => {
      await adapter.createWebhook({
        name: 'Webhook 1',
        url: 'https://example.com/1',
        enabled: true,
        events: [WebhookEventType.INSTANCE_DOWN],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
      });

      await adapter.createWebhook({
        name: 'Webhook 2',
        url: 'https://example.com/2',
        enabled: true,
        events: [WebhookEventType.MEMORY_CRITICAL],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
      });

      const webhooks = await adapter.getWebhooksByInstance();
      expect(webhooks).toHaveLength(2);
    });

    it('should filter webhooks by event type', async () => {
      const webhook1 = await adapter.createWebhook({
        name: 'Down Webhook',
        url: 'https://example.com/1',
        enabled: true,
        events: [WebhookEventType.INSTANCE_DOWN, WebhookEventType.INSTANCE_UP],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
      });

      await adapter.createWebhook({
        name: 'Memory Webhook',
        url: 'https://example.com/2',
        enabled: true,
        events: [WebhookEventType.MEMORY_CRITICAL],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
      });

      const downWebhooks = await adapter.getWebhooksByEvent(WebhookEventType.INSTANCE_DOWN);
      expect(downWebhooks).toHaveLength(1);
      expect(downWebhooks[0].id).toBe(webhook1.id);
    });

    it('should skip disabled webhooks in event filter', async () => {
      await adapter.createWebhook({
        name: 'Disabled Webhook',
        url: 'https://example.com/1',
        enabled: false,
        events: [WebhookEventType.INSTANCE_DOWN],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
      });

      const downWebhooks = await adapter.getWebhooksByEvent(WebhookEventType.INSTANCE_DOWN);
      expect(downWebhooks).toHaveLength(0);
    });

    it('should update webhook', async () => {
      const webhook = await adapter.createWebhook({
        name: 'Original Name',
        url: 'https://example.com/hook',
        enabled: true,
        events: [WebhookEventType.INSTANCE_DOWN],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
      });

      const updated = await adapter.updateWebhook(webhook.id, {
        name: 'Updated Name',
        enabled: false,
      });

      expect(updated).toMatchObject({
        id: webhook.id,
        name: 'Updated Name',
        enabled: false,
      });
    });

    it('should return null when updating non-existent webhook', async () => {
      const result = await adapter.updateWebhook('non-existent-id', { name: 'Test' });
      expect(result).toBeNull();
    });

    it('should delete webhook', async () => {
      const webhook = await adapter.createWebhook({
        name: 'To Delete',
        url: 'https://example.com/hook',
        enabled: true,
        events: [WebhookEventType.INSTANCE_DOWN],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
      });

      const deleted = await adapter.deleteWebhook(webhook.id);
      expect(deleted).toBe(true);

      const retrieved = await adapter.getWebhook(webhook.id);
      expect(retrieved).toBeNull();
    });

    it('should cascade delete deliveries when webhook deleted', async () => {
      const webhook = await adapter.createWebhook({
        name: 'Cascade Test',
        url: 'https://example.com/hook',
        enabled: true,
        events: [WebhookEventType.INSTANCE_DOWN],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
      });

      await adapter.createDelivery({
        webhookId: webhook.id,
        eventType: WebhookEventType.INSTANCE_DOWN,
        payload: {
          event: WebhookEventType.INSTANCE_DOWN,
          timestamp: Date.now(),
          data: { test: 'data' },
        },
        status: DeliveryStatus.PENDING,
        attempts: 0,
      });

      await adapter.deleteWebhook(webhook.id);

      const deliveries = await adapter.getDeliveriesByWebhook(webhook.id);
      expect(deliveries).toHaveLength(0);
    });
  });

  describe('Delivery CRUD', () => {
    let webhookId: string;

    beforeEach(async () => {
      const webhook = await adapter.createWebhook({
        name: 'Test Webhook',
        url: 'https://example.com/hook',
        enabled: true,
        events: [WebhookEventType.INSTANCE_DOWN],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
      });
      webhookId = webhook.id;
    });

    it('should create and retrieve delivery', async () => {
      const delivery = await adapter.createDelivery({
        webhookId,
        eventType: WebhookEventType.INSTANCE_DOWN,
        payload: {
          event: WebhookEventType.INSTANCE_DOWN,
          timestamp: Date.now(),
          data: { message: 'Instance down' },
        },
        status: DeliveryStatus.PENDING,
        attempts: 0,
      });

      expect(delivery).toMatchObject({
        id: expect.any(String),
        webhookId,
        eventType: WebhookEventType.INSTANCE_DOWN,
        status: DeliveryStatus.PENDING,
        attempts: 0,
        createdAt: expect.any(Number),
      });

      const retrieved = await adapter.getDelivery(delivery.id);
      expect(retrieved).toMatchObject(delivery);
    });

    it('should list deliveries by webhook', async () => {
      await adapter.createDelivery({
        webhookId,
        eventType: WebhookEventType.INSTANCE_DOWN,
        payload: {
          event: WebhookEventType.INSTANCE_DOWN,
          timestamp: Date.now(),
          data: { test: 1 },
        },
        status: DeliveryStatus.SUCCESS,
        attempts: 1,
        statusCode: 200,
      });

      await adapter.createDelivery({
        webhookId,
        eventType: WebhookEventType.INSTANCE_UP,
        payload: {
          event: WebhookEventType.INSTANCE_UP,
          timestamp: Date.now(),
          data: { test: 2 },
        },
        status: DeliveryStatus.PENDING,
        attempts: 0,
      });

      const deliveries = await adapter.getDeliveriesByWebhook(webhookId);
      expect(deliveries).toHaveLength(2);
    });

    it('should paginate deliveries with limit and offset', async () => {
      // Create 5 deliveries
      for (let i = 0; i < 5; i++) {
        await adapter.createDelivery({
          webhookId,
          eventType: WebhookEventType.INSTANCE_DOWN,
          payload: {
            event: WebhookEventType.INSTANCE_DOWN,
            timestamp: Date.now(),
            data: { index: i },
          },
          status: DeliveryStatus.SUCCESS,
          attempts: 1,
        });
      }

      // Get first 2
      const page1 = await adapter.getDeliveriesByWebhook(webhookId, 2, 0);
      expect(page1).toHaveLength(2);

      // Get next 2
      const page2 = await adapter.getDeliveriesByWebhook(webhookId, 2, 2);
      expect(page2).toHaveLength(2);
      expect(page2[0].id).not.toBe(page1[0].id);

      // Get last 1
      const page3 = await adapter.getDeliveriesByWebhook(webhookId, 2, 4);
      expect(page3).toHaveLength(1);
    });

    it('should update delivery status', async () => {
      const delivery = await adapter.createDelivery({
        webhookId,
        eventType: WebhookEventType.INSTANCE_DOWN,
        payload: {
          event: WebhookEventType.INSTANCE_DOWN,
          timestamp: Date.now(),
          data: { test: 'data' },
        },
        status: DeliveryStatus.PENDING,
        attempts: 0,
      });

      const updated = await adapter.updateDelivery(delivery.id, {
        status: DeliveryStatus.SUCCESS,
        statusCode: 200,
        responseBody: 'OK',
        completedAt: Date.now(),
        durationMs: 150,
      });

      expect(updated).toBe(true);

      const retrieved = await adapter.getDelivery(delivery.id);
      expect(retrieved).toMatchObject({
        status: DeliveryStatus.SUCCESS,
        statusCode: 200,
        responseBody: 'OK',
        durationMs: 150,
      });
    });

    it('should find retriable deliveries', async () => {
      const now = Date.now();

      // Create a delivery ready to retry
      await adapter.createDelivery({
        webhookId,
        eventType: WebhookEventType.INSTANCE_DOWN,
        payload: {
          event: WebhookEventType.INSTANCE_DOWN,
          timestamp: now,
          data: { test: 1 },
        },
        status: DeliveryStatus.RETRYING,
        attempts: 1,
        nextRetryAt: now - 1000, // Past
      });

      // Create a delivery not ready to retry yet
      await adapter.createDelivery({
        webhookId,
        eventType: WebhookEventType.INSTANCE_DOWN,
        payload: {
          event: WebhookEventType.INSTANCE_DOWN,
          timestamp: now,
          data: { test: 2 },
        },
        status: DeliveryStatus.RETRYING,
        attempts: 1,
        nextRetryAt: now + 60000, // Future
      });

      // Create a successful delivery (shouldn't be retriable)
      await adapter.createDelivery({
        webhookId,
        eventType: WebhookEventType.INSTANCE_DOWN,
        payload: {
          event: WebhookEventType.INSTANCE_DOWN,
          timestamp: now,
          data: { test: 3 },
        },
        status: DeliveryStatus.SUCCESS,
        attempts: 1,
      });

      const retriable = await adapter.getRetriableDeliveries(100);
      expect(retriable).toHaveLength(1);
      expect(retriable[0].payload.data).toMatchObject({ test: 1 });
    });

    it('should call pruneOldDeliveries without error', async () => {
      // Create a delivery
      await adapter.createDelivery({
        webhookId,
        eventType: WebhookEventType.INSTANCE_DOWN,
        payload: {
          event: WebhookEventType.INSTANCE_DOWN,
          timestamp: Date.now(),
          data: { test: 'data' },
        },
        status: DeliveryStatus.SUCCESS,
        attempts: 1,
      });

      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days
      const pruned = await adapter.pruneOldDeliveries(cutoff);

      // Should return a number (0 or more)
      expect(typeof pruned).toBe('number');
      expect(pruned).toBeGreaterThanOrEqual(0);
    });
  });
});
