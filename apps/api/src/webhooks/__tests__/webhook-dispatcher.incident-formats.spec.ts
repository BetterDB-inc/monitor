import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { ConfigService } from '@nestjs/config';
import {
  DeliveryStatus,
  WebhookEventType,
  WebhookPayloadFormat,
  type Webhook,
  type WebhookPayload,
} from '@betterdb/shared';
import { WebhookDispatcherService } from '../webhook-dispatcher.service';
import type { WebhooksService } from '../webhooks.service';
import type { StoragePort } from '../../common/interfaces/storage-port.interface';

const ROUTING_KEY = 'R0123456789ABCDEFGHIJKLMNOPQRSTU';

describe('WebhookDispatcherService incident formats', () => {
  let server: Server;
  let port: number;
  let hits: Array<{ url: string; body: Record<string, unknown> }>;
  /** Status to answer per request, consumed in order; defaults to 202. */
  let statuses: number[];
  let storage: { getDelivery: jest.Mock; updateDelivery: jest.Mock };
  let service: WebhookDispatcherService;

  const hook = (overrides: Partial<Webhook> = {}): Webhook => ({
    id: 'wh-1',
    name: 'Pager',
    url: `http://127.0.0.1:${port}/v2/enqueue`,
    secret: 'whsec_x',
    enabled: true,
    events: [WebhookEventType.INSTANCE_UP],
    headers: {},
    retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
    payloadFormat: WebhookPayloadFormat.PAGERDUTY,
    routingKey: ROUTING_KEY,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });

  const payload: WebhookPayload = {
    id: 'p1',
    event: WebhookEventType.INSTANCE_DOWN,
    timestamp: 1706457600000,
    instance: { host: 'localhost', port: 6379, connectionId: 'conn-1' },
    data: { message: 'Database instance unreachable: ECONNREFUSED' },
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        hits.push({ url: req.url ?? '', body: JSON.parse(body || '{}') });
        res.writeHead(statuses.shift() ?? 202).end('{"status":"success"}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    hits = [];
    statuses = [];
    storage = {
      getDelivery: jest.fn().mockResolvedValue({ id: 'd1', attempts: 0 }),
      updateDelivery: jest.fn().mockResolvedValue(undefined),
    };
    service = new WebhookDispatcherService(
      storage as unknown as StoragePort,
      { generateSignature: jest.fn().mockReturnValue('sig') } as unknown as WebhooksService,
      { get: jest.fn((key: string, fallback?: unknown) => fallback) } as unknown as ConfigService,
    );
  });

  it('delivers the PagerDuty Events API v2 body with the stored routing key', async () => {
    await expect(service.sendWebhook(hook(), 'd1', payload)).resolves.toBe(DeliveryStatus.SUCCESS);
    expect(hits).toHaveLength(1);
    expect(hits[0].body).toMatchObject({
      routing_key: ROUTING_KEY,
      event_action: 'trigger',
      dedup_key: 'betterdb:conn-1:instance.down',
    });
  });

  it('posts a PagerDuty change event to the Change Events endpoint', async () => {
    const post = jest
      .spyOn(service as unknown as { post: (...args: unknown[]) => Promise<Response> }, 'post')
      .mockResolvedValue(new Response('{}', { status: 202 }));
    const change: WebhookPayload = { ...payload, event: WebhookEventType.CONFIG_CHANGED, data: { configKey: 'maxmemory' } };

    await expect(
      service.sendWebhook(hook({ url: 'https://events.pagerduty.com/v2/enqueue' }), 'd1', change),
    ).resolves.toBe(DeliveryStatus.SUCCESS);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('https://events.pagerduty.com/v2/change/enqueue');
    expect(JSON.parse(post.mock.calls[0][2] as string)).toMatchObject({ routing_key: ROUTING_KEY });
  });

  it('retries a 429 instead of failing the delivery', async () => {
    statuses = [429];
    await expect(service.sendWebhook(hook(), 'd1', payload)).resolves.toBe(DeliveryStatus.RETRYING);
    expect(storage.updateDelivery).toHaveBeenCalledWith(
      'd1',
      expect.objectContaining({ status: DeliveryStatus.RETRYING, statusCode: 429, nextRetryAt: expect.any(Number) }),
    );
  });

  it('still fails other 4xx responses without retrying', async () => {
    statuses = [400];
    await expect(service.sendWebhook(hook(), 'd1', payload)).resolves.toBe(DeliveryStatus.FAILED);
  });

  it('sends an info test trigger and resolves it, even when the first subscribed event is a resolver', async () => {
    const result = await service.testWebhook(hook());

    expect(hits.map((hit) => hit.body['event_action'])).toEqual(['trigger', 'resolve']);
    expect(hits[0].body).toMatchObject({
      routing_key: ROUTING_KEY,
      dedup_key: 'betterdb:test:wh-1',
      payload: { severity: 'info' },
    });
    expect(hits[1].body).toEqual({
      routing_key: ROUTING_KEY,
      event_action: 'resolve',
      dedup_key: 'betterdb:test:wh-1',
    });
    expect(result).toMatchObject({
      success: true,
      statusCode: 202,
      payloadFormat: WebhookPayloadFormat.PAGERDUTY,
      testIncidentResolved: true,
      renderedPayload: expect.objectContaining({ event_action: 'trigger' }),
    });
  });

  it('signs the resolve request for its own body', async () => {
    const generateSignature = jest.fn((content: string) => `sig:${content.length}`);
    const signing = new WebhookDispatcherService(
      storage as unknown as StoragePort,
      { generateSignature } as unknown as WebhooksService,
      { get: jest.fn((key: string, fallback?: unknown) => fallback) } as unknown as ConfigService,
    );
    const post = jest
      .spyOn(signing as unknown as { post: (...args: unknown[]) => Promise<Response> }, 'post')
      .mockImplementation(() => Promise.resolve(new Response('{}', { status: 202 })));

    await signing.testWebhook(hook());

    expect(post).toHaveBeenCalledTimes(2);
    const [triggerHeaders, resolveHeaders] = post.mock.calls.map(
      (call) => (call[1] as Record<string, string>)['X-Webhook-Signature'],
    );
    const [triggerBody, resolveBody] = post.mock.calls.map((call) => call[2] as string);
    expect(triggerHeaders).toMatch(/^sig:/);
    expect(resolveHeaders).not.toBe(triggerHeaders);
    expect(generateSignature).toHaveBeenCalledWith(expect.stringContaining(triggerBody), 'whsec_x');
    expect(generateSignature).toHaveBeenCalledWith(expect.stringContaining(resolveBody), 'whsec_x');
  });

  it('reports a test incident it could not resolve', async () => {
    statuses = [202, 500];
    const result = await service.testWebhook(hook());
    expect(result.success).toBe(true);
    expect(result.testIncidentResolved).toBe(false);
  });

  it('does not send a resolve when the test trigger was rejected', async () => {
    statuses = [400];
    const result = await service.testWebhook(hook());
    expect(hits).toHaveLength(1);
    expect(result.success).toBe(false);
    expect(result.testIncidentResolved).toBeUndefined();
  });

  it('sends a Teams card on test and omits the PagerDuty-only field', async () => {
    statuses = [200];
    const result = await service.testWebhook(
      hook({ payloadFormat: WebhookPayloadFormat.TEAMS, routingKey: undefined, url: `http://127.0.0.1:${port}/teams` }),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].body['type']).toBe('message');
    expect(result.testIncidentResolved).toBeUndefined();
    expect('testIncidentResolved' in result).toBe(false);
  });
});
