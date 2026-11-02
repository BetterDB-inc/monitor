import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { WebhookEventType } from '@betterdb/shared';
import { createTestApp } from './test-utils';
import { createMockWebhookServer, MockWebhookServer } from './webhook-test-utils';
import { WebhookDispatcherService } from '../src/webhooks/webhook-dispatcher.service';

const ROUTING_KEY = 'R0123456789ABCDEFGHIJKLMNOPQRSTU';

describe('Webhook incident formats (e2e)', () => {
  let app: NestFastifyApplication;
  let receiver: MockWebhookServer;
  let dispatcher: WebhookDispatcherService;
  const created: string[] = [];

  const MOCK_SERVER_PORT = 19998;

  const createWebhook = async (body: Record<string, unknown>): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/webhooks').send(body).expect(201);
    created.push(res.body.id);
    return res.body.id;
  };

  beforeAll(async () => {
    app = await createTestApp();
    receiver = await createMockWebhookServer(MOCK_SERVER_PORT);
    dispatcher = app.get(WebhookDispatcherService);
  });

  afterAll(async () => {
    for (const id of created) {
      await request(app.getHttpServer()).delete(`/webhooks/${id}`);
    }
    await receiver.close();
    await app.close();
  });

  beforeEach(() => {
    receiver.clearReceivedRequests();
  });

  it('opens a PagerDuty incident on instance.down and resolves it on instance.up', async () => {
    const id = await createWebhook({
      name: 'PagerDuty lifecycle',
      url: `http://localhost:${MOCK_SERVER_PORT}/v2/enqueue`,
      events: [WebhookEventType.INSTANCE_DOWN, WebhookEventType.INSTANCE_UP],
      payloadFormat: 'pagerduty',
      routingKey: ROUTING_KEY,
    });

    await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_DOWN, {
      message: 'Database instance unreachable: ECONNREFUSED',
      host: 'localhost',
      port: 6379,
    });
    await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_UP, {
      message: 'Database instance recovered',
      host: 'localhost',
      port: 6379,
    });

    const requests = (await receiver.waitForRequests(2, 5000)).filter(
      (req) => req.headers['x-webhook-id'] === id,
    );
    expect(requests.map((req) => req.body.event_action)).toEqual(['trigger', 'resolve']);
    expect(requests[0].body).toMatchObject({
      routing_key: ROUTING_KEY,
      payload: { severity: 'critical', class: WebhookEventType.INSTANCE_DOWN },
    });
    expect(requests[1].body.dedup_key).toBe(requests[0].body.dedup_key);
  });

  it('resolves the PagerDuty test incident it opens', async () => {
    const id = await createWebhook({
      name: 'PagerDuty test',
      url: `http://localhost:${MOCK_SERVER_PORT}/v2/enqueue`,
      events: [WebhookEventType.MEMORY_CRITICAL],
      payloadFormat: 'pagerduty',
      routingKey: ROUTING_KEY,
    });

    const res = await request(app.getHttpServer()).post(`/webhooks/${id}/test`).expect(200);
    expect(res.body).toMatchObject({ success: true, payloadFormat: 'pagerduty', testIncidentResolved: true });

    const requests = await receiver.waitForRequests(2, 5000);
    expect(requests.map((req) => req.body.event_action)).toEqual(['trigger', 'resolve']);
    expect(requests.every((req) => req.body.dedup_key === `betterdb:test:${id}`)).toBe(true);
  });

  it('posts an Adaptive Card message to a Teams webhook', async () => {
    const id = await createWebhook({
      name: 'Teams',
      url: `http://localhost:${MOCK_SERVER_PORT}/teams`,
      events: [WebhookEventType.CONNECTION_CRITICAL],
      payloadFormat: 'teams',
    });

    const res = await request(app.getHttpServer()).post(`/webhooks/${id}/test`).expect(200);
    expect(res.body.success).toBe(true);

    const [received] = await receiver.waitForRequests(1, 5000);
    expect(received.path).toBe('/teams');
    expect(received.body.type).toBe('message');
    expect(received.body.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
  });
});
