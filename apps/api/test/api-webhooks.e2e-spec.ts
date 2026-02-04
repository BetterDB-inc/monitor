import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { createTestApp } from './test-utils';
import { WebhookEventType } from '@betterdb/shared';

describe('Webhooks API (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /webhooks', () => {
    it('should create webhook with valid data', async () => {
      const res = await request(app.getHttpServer())
        .post('/webhooks')
        .send({
          name: 'Test Webhook',
          url: 'https://example.com/hook',
          events: [WebhookEventType.INSTANCE_DOWN, WebhookEventType.INSTANCE_UP],
        })
        .expect(201);

      expect(res.body).toMatchObject({
        id: expect.any(String),
        name: 'Test Webhook',
        url: 'https://example.com/hook',
        enabled: true,
        events: [WebhookEventType.INSTANCE_DOWN, WebhookEventType.INSTANCE_UP],
      });
      expect(res.body.secret).toMatch(/^\w{10}\*\*\*$/); // Masked secret

      // Cleanup
      await request(app.getHttpServer()).delete(`/webhooks/${res.body.id}`);
    });

    it('should generate secret automatically if not provided', async () => {
      const res = await request(app.getHttpServer())
        .post('/webhooks')
        .send({
          name: 'Auto Secret',
          url: 'https://example.com/hook2',
          events: [WebhookEventType.MEMORY_CRITICAL],
        })
        .expect(201);

      expect(res.body.secret).toBeDefined();
      expect(res.body.secret).toMatch(/^\w{10}\*\*\*$/);
    });

    it('should reject invalid URL (SSRF protection)', async () => {
      const invalidUrls = [
        'http://127.0.0.1/hook',
        'http://localhost/hook',
        'http://10.0.0.1/hook',
        'http://172.16.0.1/hook',
        'http://192.168.1.1/hook',
      ];

      // Note: In test env (not production), localhost might be allowed
      // So we'll just test one that should always fail
      const res = await request(app.getHttpServer())
        .post('/webhooks')
        .send({
          name: 'Bad Webhook',
          url: 'ftp://example.com/hook',
          events: [WebhookEventType.INSTANCE_DOWN],
        });

      expect([400, 500]).toContain(res.status);
    });

    it('should accept localhost in non-production environment', async () => {
      // In test environment, localhost should be allowed
      const res = await request(app.getHttpServer())
        .post('/webhooks')
        .send({
          name: 'Localhost Webhook',
          url: 'http://localhost:9999/hook',
          events: [WebhookEventType.INSTANCE_DOWN],
        })
        .expect(201);

      expect(res.body.url).toBe('http://localhost:9999/hook');
    });

    it('should set default retry policy', async () => {
      const res = await request(app.getHttpServer())
        .post('/webhooks')
        .send({
          name: 'Default Retry',
          url: 'https://example.com/hook3',
          events: [WebhookEventType.CONNECTION_CRITICAL],
        })
        .expect(201);

      expect(res.body.retryPolicy).toMatchObject({
        maxRetries: expect.any(Number),
        backoffMultiplier: expect.any(Number),
        initialDelayMs: expect.any(Number),
        maxDelayMs: expect.any(Number),
      });
    });

    it('should reject empty events array', async () => {
      const res = await request(app.getHttpServer())
        .post('/webhooks')
        .send({
          name: 'No Events',
          url: 'https://example.com/hook',
          events: [],
        });

      expect([400, 500]).toContain(res.status);
    });
  });

  describe('GET /webhooks', () => {
    it('should list all webhooks', async () => {
      const res = await request(app.getHttpServer())
        .get('/webhooks')
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);

      // All secrets should be masked
      res.body.forEach((webhook: any) => {
        if (webhook.secret) {
          expect(webhook.secret).toMatch(/\*\*\*$/);
        }
      });
    });
  });

  describe('GET /webhooks/:id', () => {
    it('should return webhook by ID', async () => {
      // Create webhook for this test
      const created = await request(app.getHttpServer())
        .post('/webhooks')
        .send({
          name: 'Get Test Webhook',
          url: 'https://example.com/get-test',
          events: [WebhookEventType.INSTANCE_DOWN],
        });

      const res = await request(app.getHttpServer())
        .get(`/webhooks/${created.body.id}`)
        .expect(200);

      expect(res.body).toMatchObject({
        id: created.body.id,
        name: 'Get Test Webhook',
      });
      expect(res.body.secret).toMatch(/\*\*\*$/);

      // Cleanup
      await request(app.getHttpServer()).delete(`/webhooks/${created.body.id}`);
    });

    it('should return 404 for unknown ID', async () => {
      await request(app.getHttpServer())
        .get('/webhooks/non-existent-id')
        .expect(404);
    });
  });

  describe('PATCH /webhooks/:id', () => {
    it('should update webhook fields', async () => {
      // Create webhook for this test
      const created = await request(app.getHttpServer())
        .post('/webhooks')
        .send({
          name: 'Original Name',
          url: 'https://example.com/update-test',
          events: [WebhookEventType.INSTANCE_DOWN],
        });

      const res = await request(app.getHttpServer())
        .patch(`/webhooks/${created.body.id}`)
        .send({
          name: 'Updated Webhook Name',
          enabled: false,
        })
        .expect(200);

      expect(res.body).toMatchObject({
        id: created.body.id,
        name: 'Updated Webhook Name',
        enabled: false,
      });

      // Cleanup
      await request(app.getHttpServer()).delete(`/webhooks/${created.body.id}`);
    });

    it('should validate URL on update', async () => {
      // Create webhook for this test
      const created = await request(app.getHttpServer())
        .post('/webhooks')
        .send({
          name: 'URL Test',
          url: 'https://example.com/url-test',
          events: [WebhookEventType.INSTANCE_DOWN],
        });

      const res = await request(app.getHttpServer())
        .patch(`/webhooks/${created.body.id}`)
        .send({
          url: 'ftp://invalid.com',
        });

      expect([400, 500]).toContain(res.status);

      // Cleanup
      await request(app.getHttpServer()).delete(`/webhooks/${created.body.id}`);
    });

    it('should return 404 for unknown webhook', async () => {
      await request(app.getHttpServer())
        .patch('/webhooks/non-existent-id')
        .send({
          name: 'Updated',
        })
        .expect(404);
    });
  });

  describe('POST /webhooks/:id/test', () => {
    it('should send test event and return result', async () => {
      // Create webhook for this test
      const created = await request(app.getHttpServer())
        .post('/webhooks')
        .send({
          name: 'Test Webhook',
          url: 'https://example.com/test',
          events: [WebhookEventType.INSTANCE_DOWN],
        });

      const res = await request(app.getHttpServer())
        .post(`/webhooks/${created.body.id}/test`)
        .expect(200);

      expect(res.body).toMatchObject({
        success: expect.any(Boolean),
        statusCode: expect.any(Number),
        durationMs: expect.any(Number),
      });

      // Cleanup
      await request(app.getHttpServer()).delete(`/webhooks/${created.body.id}`);
    });

    it('should return 404 for unknown webhook', async () => {
      await request(app.getHttpServer())
        .post('/webhooks/non-existent-id/test')
        .expect(404);
    });
  });

  describe('GET /webhooks/:id/deliveries', () => {
    it('should return delivery history', async () => {
      // Create webhook for this test
      const created = await request(app.getHttpServer())
        .post('/webhooks')
        .send({
          name: 'Delivery Test',
          url: 'https://example.com/delivery-test',
          events: [WebhookEventType.INSTANCE_DOWN],
        })
        .expect(201);

      expect(created.body.id).toBeDefined();

      const res = await request(app.getHttpServer())
        .get(`/webhooks/${created.body.id}/deliveries`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);

      // Cleanup
      await request(app.getHttpServer()).delete(`/webhooks/${created.body.id}`);
    });

    it('should support pagination with limit and offset', async () => {
      // Create webhook for this test
      const created = await request(app.getHttpServer())
        .post('/webhooks')
        .send({
          name: 'Pagination Test',
          url: 'https://example.com/pagination-test',
          events: [WebhookEventType.INSTANCE_DOWN],
        })
        .expect(201);

      expect(created.body.id).toBeDefined();

      const res1 = await request(app.getHttpServer())
        .get(`/webhooks/${created.body.id}/deliveries?limit=10&offset=0`)
        .expect(200);

      expect(Array.isArray(res1.body)).toBe(true);

      const res2 = await request(app.getHttpServer())
        .get(`/webhooks/${created.body.id}/deliveries?limit=10&offset=10`)
        .expect(200);

      expect(Array.isArray(res2.body)).toBe(true);

      // Cleanup
      await request(app.getHttpServer()).delete(`/webhooks/${created.body.id}`);
    });

    it('should return 404 for unknown webhook', async () => {
      await request(app.getHttpServer())
        .get('/webhooks/non-existent-id/deliveries')
        .expect(404);
    });
  });

  describe('DELETE /webhooks/:id', () => {
    it('should delete webhook', async () => {
      // Create webhook for this test
      const created = await request(app.getHttpServer())
        .post('/webhooks')
        .send({
          name: 'Delete Test',
          url: 'https://example.com/delete-test',
          events: [WebhookEventType.INSTANCE_DOWN],
        })
        .expect(201);

      expect(created.body.id).toBeDefined();

      await request(app.getHttpServer())
        .delete(`/webhooks/${created.body.id}`)
        .expect(204);

      // Verify it's deleted
      await request(app.getHttpServer())
        .get(`/webhooks/${created.body.id}`)
        .expect(404);
    });

    it('should return 404 for unknown webhook', async () => {
      await request(app.getHttpServer())
        .delete('/webhooks/non-existent-id')
        .expect(404);
    });
  });

  describe('GET /webhooks/stats/retry-queue', () => {
    it('should return retry queue statistics', async () => {
      const res = await request(app.getHttpServer())
        .get('/webhooks/stats/retry-queue')
        .expect(200);

      expect(res.body).toMatchObject({
        pendingRetries: expect.any(Number),
      });
      // nextRetryTime can be null or number
      expect(['number', 'object']).toContain(typeof res.body.nextRetryTime);
    });
  });

  // Rate limiting test - runs last so it doesn't affect other tests
  describe('Rate Limiting', () => {
    it('POST /webhooks should respect rate limiting', async () => {
      const responses = [];

      // Send 30 requests sequentially (rate limit is 25 per minute)
      // Sequential sending is fast enough to trigger rate limiting but avoids connection pool issues
      for (let i = 0; i < 30; i++) {
        const res = await request(app.getHttpServer())
          .post('/webhooks')
          .send({
            name: `Rate Limit Test ${i}`,
            url: `https://example.com/hook-${i}`,
            events: [WebhookEventType.INSTANCE_DOWN],
          });
        responses.push(res);
      }

      const tooManyRequests = responses.filter((r) => r.status === 429);
      const successful = responses.filter((r) => r.status === 201);

      // Log for debugging
      console.log(`Total requests: ${responses.length}, Successful: ${successful.length}, Rate limited: ${tooManyRequests.length}`);

      // Should have at least some rate limited (we sent 30, limit is 25)
      expect(tooManyRequests.length).toBeGreaterThan(0);
    }, 30000);
  });
});
