import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { createTestApp } from './test-utils';

/**
 * This test proves end-to-end that data written with one connection ID
 * does NOT appear when queried with a different connection ID.
 *
 * It uses the webhook CRUD endpoints since they don't require
 * a live Valkey connection — they're purely storage-backed.
 *
 * Note: The backend uses X-Connection-Id header, NOT ?dbId= query param.
 */
describe('End-to-End Connection Data Isolation', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('webhook created on connection A must NOT appear on connection B', async () => {
    const CONN_A = 'e2e-isolation-test-A';
    const CONN_B = 'e2e-isolation-test-B';

    // Create webhook on connection A
    const createRes = await request(app.getHttpServer())
      .post('/webhooks')
      .set('X-Connection-Id', CONN_A)
      .send({
        name: 'Webhook for A only',
        url: 'https://example.com/webhook-a',
        events: ['instance.down'],
        enabled: true,
      })
      .expect((res) => {
        // Accept 201 or 200
        expect([200, 201]).toContain(res.status);
      });

    const webhookId = createRes.body?.id;
    expect(webhookId).toBeDefined();

    try {
      // List webhooks on connection B — MUST NOT contain the webhook
      const listB = await request(app.getHttpServer())
        .get('/webhooks')
        .set('X-Connection-Id', CONN_B)
        .expect(200);

      const webhookIdsOnB = (listB.body || []).map((w: any) => w.id);
      expect(webhookIdsOnB).not.toContain(webhookId);

      // List webhooks on connection A — MUST contain it
      const listA = await request(app.getHttpServer())
        .get('/webhooks')
        .set('X-Connection-Id', CONN_A)
        .expect(200);

      const webhookIdsOnA = (listA.body || []).map((w: any) => w.id);
      expect(webhookIdsOnA).toContain(webhookId);

      // Verify the webhook details are correct
      const webhookOnA = listA.body.find((w: any) => w.id === webhookId);
      expect(webhookOnA.name).toBe('Webhook for A only');
      expect(webhookOnA.url).toBe('https://example.com/webhook-a');
    } finally {
      // Clean up - delete the webhook
      if (webhookId) {
        await request(app.getHttpServer())
          .delete(`/webhooks/${webhookId}`)
          .set('X-Connection-Id', CONN_A);
      }
    }
  });

  it('multiple webhooks on different connections stay isolated', async () => {
    const CONN_A = 'multi-isolation-A';
    const CONN_B = 'multi-isolation-B';
    const CONN_C = 'multi-isolation-C';

    let webhookA: string | undefined;
    let webhookB: string | undefined;
    let webhookC: string | undefined;

    try {
      // Create webhooks on each connection
      const resA = await request(app.getHttpServer())
        .post('/webhooks')
        .set('X-Connection-Id', CONN_A)
        .send({
          name: 'Webhook A',
          url: 'https://example.com/a',
          events: ['instance.down'],
        });
      webhookA = resA.body?.id;

      const resB = await request(app.getHttpServer())
        .post('/webhooks')
        .set('X-Connection-Id', CONN_B)
        .send({
          name: 'Webhook B',
          url: 'https://example.com/b',
          events: ['memory.critical'],
        });
      webhookB = resB.body?.id;

      const resC = await request(app.getHttpServer())
        .post('/webhooks')
        .set('X-Connection-Id', CONN_C)
        .send({
          name: 'Webhook C',
          url: 'https://example.com/c',
          events: ['connection.critical'],
        });
      webhookC = resC.body?.id;

      // Verify each connection only sees its own webhook
      const listA = await request(app.getHttpServer())
        .get('/webhooks')
        .set('X-Connection-Id', CONN_A)
        .expect(200);
      const idsA = listA.body.map((w: any) => w.id);
      expect(idsA).toContain(webhookA);
      expect(idsA).not.toContain(webhookB);
      expect(idsA).not.toContain(webhookC);

      const listB = await request(app.getHttpServer())
        .get('/webhooks')
        .set('X-Connection-Id', CONN_B)
        .expect(200);
      const idsB = listB.body.map((w: any) => w.id);
      expect(idsB).toContain(webhookB);
      expect(idsB).not.toContain(webhookA);
      expect(idsB).not.toContain(webhookC);

      const listC = await request(app.getHttpServer())
        .get('/webhooks')
        .set('X-Connection-Id', CONN_C)
        .expect(200);
      const idsC = listC.body.map((w: any) => w.id);
      expect(idsC).toContain(webhookC);
      expect(idsC).not.toContain(webhookA);
      expect(idsC).not.toContain(webhookB);
    } finally {
      // Cleanup
      if (webhookA) {
        await request(app.getHttpServer())
          .delete(`/webhooks/${webhookA}`)
          .set('X-Connection-Id', CONN_A);
      }
      if (webhookB) {
        await request(app.getHttpServer())
          .delete(`/webhooks/${webhookB}`)
          .set('X-Connection-Id', CONN_B);
      }
      if (webhookC) {
        await request(app.getHttpServer())
          .delete(`/webhooks/${webhookC}`)
          .set('X-Connection-Id', CONN_C);
      }
    }
  });
});
