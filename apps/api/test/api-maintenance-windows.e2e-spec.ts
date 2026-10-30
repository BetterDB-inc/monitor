import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { WebhookEventType } from '@betterdb/shared';
import { createTestApp } from './test-utils';
import { createMockWebhookServer, MockWebhookServer } from './webhook-test-utils';
import { WebhookDispatcherService } from '../src/webhooks/webhook-dispatcher.service';

const HOUR = 60 * 60 * 1000;

describe('Maintenance windows API (e2e)', () => {
  let app: NestFastifyApplication;
  let receiver: MockWebhookServer;
  let dispatcher: WebhookDispatcherService;
  let webhookId: string;

  const MOCK_SERVER_PORT = 19997;

  beforeAll(async () => {
    app = await createTestApp();
    receiver = await createMockWebhookServer(MOCK_SERVER_PORT);
    dispatcher = app.get(WebhookDispatcherService);

    const res = await request(app.getHttpServer())
      .post('/webhooks')
      .send({
        name: 'Maintenance e2e',
        url: `http://localhost:${MOCK_SERVER_PORT}/hook`,
        events: [WebhookEventType.CLIENT_BLOCKED],
      })
      .expect(201);
    webhookId = res.body.id;
  });

  afterAll(async () => {
    await request(app.getHttpServer()).delete(`/webhooks/${webhookId}`);
    await receiver.close();
    await app.close();
  });

  beforeEach(() => {
    receiver.clearReceivedRequests();
  });

  it('silences matching alerts while active and sends them again once ended', async () => {
    const created = await request(app.getHttpServer())
      .post('/maintenance-windows')
      .send({
        name: 'e2e window',
        reason: 'CHG-e2e',
        events: [WebhookEventType.CLIENT_BLOCKED],
        endsAt: Date.now() + HOUR,
      })
      .expect(201);
    expect(created.body).toMatchObject({
      name: 'e2e window',
      reason: 'CHG-e2e',
      connectionId: null,
      events: [WebhookEventType.CLIENT_BLOCKED],
      state: 'active',
    });

    await dispatcher.dispatchEvent(WebhookEventType.CLIENT_BLOCKED, { message: 'blocked during maintenance' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(receiver.getReceivedRequests()).toHaveLength(0);

    const deliveries = await request(app.getHttpServer()).get(`/webhooks/${webhookId}/deliveries`).expect(200);
    expect(deliveries.body[0]).toMatchObject({
      status: 'suppressed',
      eventType: WebhookEventType.CLIENT_BLOCKED,
      responseBody: `Suppressed by maintenance window "e2e window" (${created.body.id})`,
    });

    const ended = await request(app.getHttpServer())
      .post(`/maintenance-windows/${created.body.id}/end`)
      .expect(200);
    expect(ended.body.state).toBe('ended');

    await dispatcher.dispatchEvent(WebhookEventType.CLIENT_BLOCKED, { message: 'blocked after maintenance' });
    const requests = await receiver.waitForRequests(1, 5000);
    expect(requests[0].body.data.message).toBe('blocked after maintenance');

    await request(app.getHttpServer()).delete(`/maintenance-windows/${created.body.id}`).expect(204);
  });

  it('lists windows and filters by state', async () => {
    const created = await request(app.getHttpServer())
      .post('/maintenance-windows')
      .send({ name: 'later', startsAt: Date.now() + HOUR, endsAt: Date.now() + 2 * HOUR })
      .expect(201);
    expect(created.body.state).toBe('scheduled');

    const scheduled = await request(app.getHttpServer()).get('/maintenance-windows?state=scheduled').expect(200);
    expect(scheduled.body.map((window: { id: string }) => window.id)).toContain(created.body.id);

    await request(app.getHttpServer()).get('/maintenance-windows?state=paused').expect(400);
    await request(app.getHttpServer()).delete(`/maintenance-windows/${created.body.id}`).expect(204);
    await request(app.getHttpServer()).get(`/maintenance-windows/${created.body.id}`).expect(404);
  });

  it('rejects windows longer than seven days, in the past, or with unknown fields', async () => {
    await request(app.getHttpServer())
      .post('/maintenance-windows')
      .send({ name: 'too long', endsAt: Date.now() + 8 * 24 * HOUR })
      .expect(400);
    await request(app.getHttpServer())
      .post('/maintenance-windows')
      .send({ name: 'past', startsAt: Date.now() - 2 * HOUR, endsAt: Date.now() + HOUR })
      .expect(400);
    await request(app.getHttpServer())
      .post('/maintenance-windows')
      .send({ name: 'extra', endsAt: Date.now() + HOUR, forever: true })
      .expect(400);
  });
});
