import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { createTestApp } from './test-utils';
import { createMockWebhookServer, MockWebhookServer } from './webhook-test-utils';
import { WebhookEventType } from '@betterdb/shared';
import { WebhookDispatcherService } from '../src/webhooks/webhook-dispatcher.service';

describe('Webhook Event Dispatch (e2e)', () => {
  let app: NestFastifyApplication;
  let mockServer: MockWebhookServer;
  let webhookId: string;
  let dispatcher: WebhookDispatcherService;

  const MOCK_SERVER_PORT = 19999;

  beforeAll(async () => {
    app = await createTestApp();
    mockServer = await createMockWebhookServer(MOCK_SERVER_PORT);
    dispatcher = app.get(WebhookDispatcherService);

    // Create a webhook pointing to our mock server
    const res = await request(app.getHttpServer())
      .post('/webhooks')
      .send({
        name: 'Event Test Webhook',
        url: `http://localhost:${MOCK_SERVER_PORT}/hook`,
        events: [
          WebhookEventType.INSTANCE_DOWN,
          WebhookEventType.INSTANCE_UP,
          WebhookEventType.MEMORY_CRITICAL,
          WebhookEventType.CONNECTION_CRITICAL,
        ],
      });

    webhookId = res.body.id;
  });

  afterAll(async () => {
    await mockServer.close();
    await app.close();
  });

  beforeEach(() => {
    mockServer.clearReceivedRequests();
  });

  describe('Instance Events', () => {
    it('should dispatch instance.down event', async () => {
      await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_DOWN, {
        message: 'Database instance is down',
        host: 'localhost',
        port: 6379,
        timestamp: Date.now(),
      });

      const requests = await mockServer.waitForRequests(1, 3000);

      expect(requests).toHaveLength(1);
      expect(requests[0].body).toMatchObject({
        event: WebhookEventType.INSTANCE_DOWN,
        data: expect.objectContaining({
          message: 'Database instance is down',
          host: 'localhost',
          port: 6379,
        }),
      });
    });

    it('should dispatch instance.up event', async () => {
      await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_UP, {
        message: 'Database instance is up',
        host: 'localhost',
        port: 6379,
        timestamp: Date.now(),
      });

      const requests = await mockServer.waitForRequests(1, 3000);

      expect(requests).toHaveLength(1);
      expect(requests[0].body.event).toBe(WebhookEventType.INSTANCE_UP);
    });
  });

  describe('Threshold Events', () => {
    it('should dispatch memory.critical when threshold exceeded', async () => {
      await dispatcher.dispatchThresholdAlert(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_usage',
        95.5,
        90,
        true,
        {
          usedMemory: 950000000,
          maxMemory: 1000000000,
          usedPercent: '95.50',
        }
      );

      const requests = await mockServer.waitForRequests(1, 3000);

      expect(requests).toHaveLength(1);
      expect(requests[0].body).toMatchObject({
        event: WebhookEventType.MEMORY_CRITICAL,
        data: expect.objectContaining({
          usedMemory: 950000000,
          maxMemory: 1000000000,
          usedPercent: '95.50',
        }),
      });
    });

    it('should not re-fire memory.critical while threshold still exceeded', async () => {
      // First fire
      await dispatcher.dispatchThresholdAlert(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_refired',
        92,
        90,
        true,
        {}
      );

      await mockServer.waitForRequests(1, 3000);
      mockServer.clearReceivedRequests();

      // Second fire - should not trigger webhook
      await dispatcher.dispatchThresholdAlert(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_refired',
        93,
        90,
        true,
        {}
      );

      // Wait a bit to see if any requests arrive
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(mockServer.getReceivedRequests()).toHaveLength(0);
    });

    it('should dispatch connection.critical when threshold exceeded', async () => {
      await dispatcher.dispatchThresholdAlert(
        WebhookEventType.CONNECTION_CRITICAL,
        'client_connections',
        10500,
        10000,
        true,
        {
          currentConnections: 10500,
          maxConnections: 10000,
        }
      );

      const requests = await mockServer.waitForRequests(1, 3000);

      expect(requests).toHaveLength(1);
      expect(requests[0].body.event).toBe(WebhookEventType.CONNECTION_CRITICAL);
    });
  });

  describe('Signature Verification', () => {
    it('should include valid X-Webhook-Signature header', async () => {
      await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_DOWN, {
        message: 'Test signature',
        timestamp: Date.now(),
      });

      const requests = await mockServer.waitForRequests(1, 3000);

      expect(requests[0].headers['x-webhook-signature']).toBeDefined();
      expect(requests[0].headers['x-webhook-signature']).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should include timestamp in X-Webhook-Timestamp header', async () => {
      await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_UP, {
        message: 'Test timestamp',
        timestamp: Date.now(),
      });

      const requests = await mockServer.waitForRequests(1, 3000);

      expect(requests[0].headers['x-webhook-timestamp']).toBeDefined();
      const timestamp = Number(requests[0].headers['x-webhook-timestamp']);
      expect(timestamp).toBeGreaterThan(Date.now() - 10000); // Within last 10 seconds
    });
  });

  describe('Disabled Webhooks', () => {
    it('should not dispatch to disabled webhooks', async () => {
      // Disable the webhook
      await request(app.getHttpServer())
        .put(`/webhooks/${webhookId}`)
        .send({ enabled: false });

      await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_DOWN, {
        message: 'Should not dispatch',
        timestamp: Date.now(),
      });

      // Wait to ensure no requests arrive
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(mockServer.getReceivedRequests()).toHaveLength(0);

      // Re-enable for other tests
      await request(app.getHttpServer())
        .put(`/webhooks/${webhookId}`)
        .send({ enabled: true });
    });
  });

  describe('Retry Behavior', () => {
    it('should retry on 5xx error', async () => {
      // Make mock server return 500
      mockServer.setResponseCode(500);

      await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_DOWN, {
        message: 'Test retry',
        timestamp: Date.now(),
      });

      const requests = await mockServer.waitForRequests(1, 3000);
      expect(requests).toHaveLength(1);

      // Check that delivery was marked for retry
      const deliveries = await request(app.getHttpServer())
        .get(`/webhooks/${webhookId}/deliveries`)
        .expect(200);

      const failedDeliveries = deliveries.body.filter(
        (d: any) => d.status === 'retrying' || d.status === 'failed'
      );
      expect(failedDeliveries.length).toBeGreaterThan(0);

      // Reset mock server
      mockServer.setResponseCode(200);
    });

    it('should not retry on 4xx error', async () => {
      // Make mock server return 400
      mockServer.setResponseCode(400);

      await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_DOWN, {
        message: 'Test no retry on 4xx',
        timestamp: Date.now(),
      });

      const requests = await mockServer.waitForRequests(1, 3000);
      expect(requests).toHaveLength(1);

      // Check that delivery was marked as failed (not retrying)
      const deliveries = await request(app.getHttpServer())
        .get(`/webhooks/${webhookId}/deliveries`)
        .expect(200);

      const recentDeliveries = deliveries.body.slice(0, 5);
      const fourxxFailed = recentDeliveries.filter(
        (d: any) => d.statusCode === 400 && d.status === 'failed'
      );
      expect(fourxxFailed.length).toBeGreaterThan(0);

      // Reset mock server
      mockServer.setResponseCode(200);
    });
  });

  describe('Custom Headers', () => {
    it('should include custom headers in webhook request', async () => {
      // Create webhook with custom headers
      const res = await request(app.getHttpServer())
        .post('/webhooks')
        .send({
          name: 'Custom Headers Webhook',
          url: `http://localhost:${MOCK_SERVER_PORT}/hook`,
          events: [WebhookEventType.INSTANCE_DOWN],
          headers: {
            'X-Custom-Header': 'custom-value',
            'Authorization': 'Bearer test-token',
          },
        });

      const customWebhookId = res.body.id;

      await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_DOWN, {
        message: 'Test custom headers',
        timestamp: Date.now(),
      });

      // Wait for 2 requests (main webhook + custom headers webhook)
      const requests = await mockServer.waitForRequests(2, 3000);

      // Find the request with custom headers (from the new webhook)
      const customHeadersRequest = requests.find((r) => r.headers['x-custom-header'] === 'custom-value');
      expect(customHeadersRequest).toBeDefined();
      expect(customHeadersRequest!.headers['x-custom-header']).toBe('custom-value');
      expect(customHeadersRequest!.headers['authorization']).toBe('Bearer test-token');

      // Cleanup
      await request(app.getHttpServer())
        .delete(`/webhooks/${customWebhookId}`);
    });
  });

  describe('Event Filtering', () => {
    it('should only dispatch to webhooks subscribed to the event', async () => {
      // Create webhook for different event
      const res = await request(app.getHttpServer())
        .post('/webhooks')
        .send({
          name: 'Client Blocked Only',
          url: `http://localhost:${MOCK_SERVER_PORT}/hook`,
          events: [WebhookEventType.CLIENT_BLOCKED],
        });

      const filteredWebhookId = res.body.id;

      // Dispatch instance.down (which filtered webhook is NOT subscribed to)
      await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_DOWN, {
        message: 'Should not reach client.blocked webhook',
        timestamp: Date.now(),
      });

      // Should only get request from the main webhook, not the filtered one
      const requests = await mockServer.waitForRequests(1, 3000);

      // All requests should be for instance.down
      expect(requests.every((r) => r.body.event === WebhookEventType.INSTANCE_DOWN)).toBe(true);

      // Cleanup
      await request(app.getHttpServer())
        .delete(`/webhooks/${filteredWebhookId}`);
    });
  });
});
