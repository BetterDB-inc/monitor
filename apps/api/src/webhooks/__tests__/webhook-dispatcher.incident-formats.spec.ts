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
import { BlockedAddressError } from '../../common/utils/outbound-url-guard';
import type { StoragePort } from '../../common/interfaces/storage-port.interface';

const ROUTING_KEY = 'R0123456789ABCDEFGHIJKLMNOPQRSTU';

describe('WebhookDispatcherService incident formats', () => {
  let server: Server;
  let port: number;
  let hits: Array<{ url: string; body: Record<string, unknown> }>;
  /** Status to answer per request, consumed in order; defaults to 202. */
  let statuses: number[];
  /** Delay in ms before answering each request, consumed in order; defaults to none. */
  let delays: number[];
  /** Retry-After header for 429 responses, if any. */
  let retryAfter: string | undefined;
  let storage: { getDelivery: jest.Mock; updateDelivery: jest.Mock; getDeliveriesByWebhook?: jest.Mock };
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
        const status = statuses.shift() ?? 202;
        setTimeout(() => {
          res
            .writeHead(status, status === 429 && retryAfter ? { 'Retry-After': retryAfter } : {})
            .end('{"status":"success"}');
        }, delays.shift() ?? 0);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    hits = [];
    statuses = [];
    delays = [];
    retryAfter = undefined;
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

  describe('429 scheduling', () => {
    it('429 with Retry-After: 30 schedules no earlier than 30 s', async () => {
      statuses = [429];
      retryAfter = '30';
      await service.sendWebhook(hook(), 'd1', payload);
      const update = storage.updateDelivery.mock.calls[0][1];
      expect(update.nextRetryAt).toBeGreaterThanOrEqual(Date.now() + 29_000);
    });

    it('429 does not consume maxRetries', async () => {
      storage.getDelivery.mockResolvedValue({ id: 'd1', attempts: 3, createdAt: Date.now() });
      statuses = [429];
      await expect(service.sendWebhook(hook(), 'd1', payload)).resolves.toBe(DeliveryStatus.RETRYING);
      expect(storage.updateDelivery).toHaveBeenCalledWith(
        'd1',
        expect.objectContaining({ status: DeliveryStatus.RETRYING, attempts: 3, nextRetryAt: expect.any(Number) }),
      );
    });

    it('a 500 at maxRetries still dead-letters', async () => {
      storage.getDelivery.mockResolvedValue({ id: 'd1', attempts: 2, createdAt: Date.now() });
      statuses = [500];
      await service.sendWebhook(hook(), 'd1', payload);
      expect(storage.updateDelivery.mock.calls[0][1]).toMatchObject({
        status: DeliveryStatus.DEAD_LETTER,
        attempts: 3,
      });
    });

    it('429 past the 1 h window fails the delivery', async () => {
      storage.getDelivery.mockResolvedValue({ id: 'd1', attempts: 1, createdAt: Date.now() - 2 * 60 * 60_000 });
      statuses = [429];
      await service.sendWebhook(hook(), 'd1', payload);
      expect(storage.updateDelivery.mock.calls[0][1]).toMatchObject({
        status: DeliveryStatus.FAILED,
        responseBody: 'Rate limited (HTTP 429) for over 1 h; giving up',
      });
    });
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
    expect(result.renderedPayload?.['routing_key']).toBe('R012***');
    expect(hits[0].body.routing_key).toBe(ROUTING_KEY);
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

  describe('test incident when the trigger response is lost', () => {
    type Poster = { post: (...args: unknown[]) => Promise<Response> };

    it('resolves after a trigger timeout', async () => {
      const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
      const post = jest
        .spyOn(service as unknown as Poster, 'post')
        .mockRejectedValueOnce(abort)
        .mockResolvedValueOnce(new Response('{}', { status: 202 }));
      const result = await service.testWebhook(hook());
      expect(result.success).toBe(false);
      expect(post).toHaveBeenCalledTimes(2);
      expect(JSON.parse(post.mock.calls[1][2] as string).event_action).toBe('resolve');
      expect(result.testIncidentResolved).toBe(true);
    });

    it('resolves after a 500', async () => {
      statuses = [500, 202];
      const result = await service.testWebhook(hook());
      expect(hits.map((hit) => hit.body['event_action'])).toEqual(['trigger', 'resolve']);
      expect(result).toMatchObject({ success: false, testIncidentResolved: true });
    });

    it('does not resolve after a 429', async () => {
      statuses = [429];
      const result = await service.testWebhook(hook());
      expect(hits.map((hit) => hit.body['event_action'])).toEqual(['trigger']);
      expect('testIncidentResolved' in result).toBe(false);
    });

    it('does not resolve when the connection is refused', async () => {
      const post = jest
        .spyOn(service as unknown as Poster, 'post')
        .mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      const result = await service.testWebhook(hook());
      expect(post).toHaveBeenCalledTimes(1);
      expect('testIncidentResolved' in result).toBe(false);
    });

    it('does not resolve when the address is blocked', async () => {
      const post = jest
        .spyOn(service as unknown as Poster, 'post')
        .mockRejectedValue(new BlockedAddressError('blocked address'));
      const result = await service.testWebhook(hook());
      expect(post).toHaveBeenCalledTimes(1);
      expect('testIncidentResolved' in result).toBe(false);
    });

    it('sends nothing, and reports no resolve, when the request is never sent', async () => {
      const post = jest.spyOn(service as unknown as Poster, 'post');
      jest
        .spyOn(service as unknown as { sanitizeHeaders: () => never }, 'sanitizeHeaders')
        .mockImplementation(() => {
          throw new Error('blocked before send');
        });
      const result = await service.testWebhook(hook());
      expect(post).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect('testIncidentResolved' in result).toBe(false);
    });
  });

  describe('retried trigger after the incident was resolved', () => {
    const up: WebhookPayload = {
      ...payload,
      id: 'p-up',
      event: WebhookEventType.INSTANCE_UP,
      timestamp: payload.timestamp + 60_000,
    };

    const deliver = async (deliveryAttempts: number, p: WebhookPayload) => {
      storage.getDelivery.mockResolvedValue({ id: 'd1', attempts: deliveryAttempts });
      return service.sendWebhook(hook(), 'd1', p);
    };

    it('skips the retry without sending, and finishes the delivery', async () => {
      await deliver(0, up);
      hits = [];
      storage.updateDelivery.mockClear();

      await expect(deliver(1, payload)).resolves.toBe(DeliveryStatus.SUCCESS);

      expect(hits).toHaveLength(0);
      const update = storage.updateDelivery.mock.calls[0][1];
      expect(update).toMatchObject({
        status: DeliveryStatus.SUCCESS,
        responseBody: 'Not sent: incident already resolved by a later recovery event',
      });
      expect(update.statusCode).toBeUndefined();
      expect(update.nextRetryAt).toBeUndefined();
    });

    it('sends the retry when the resolve was for a different connection', async () => {
      await deliver(0, { ...up, instance: { host: 'localhost', port: 6379, connectionId: 'conn-2' } });
      hits = [];
      await deliver(1, payload);
      expect(hits).toHaveLength(1);
      expect(hits[0].body['event_action']).toBe('trigger');
    });

    it('sends a first attempt even after a resolve', async () => {
      await deliver(0, up);
      hits = [];
      await deliver(0, payload);
      expect(hits).toHaveLength(1);
    });

    it('sends the retry when the resolve is older than the trigger', async () => {
      await deliver(0, { ...up, timestamp: payload.timestamp - 1 });
      hits = [];
      await deliver(1, payload);
      expect(hits).toHaveLength(1);
    });

    it('does not check non-PagerDuty formats', async () => {
      const teams = hook({ payloadFormat: WebhookPayloadFormat.TEAMS, routingKey: undefined });
      await service.sendWebhook(teams, 'd1', up);
      hits = [];
      storage.getDelivery.mockResolvedValue({ id: 'd1', attempts: 1 });
      await service.sendWebhook(teams, 'd1', payload);
      expect(hits).toHaveLength(1);
    });

    it('falls back to stored deliveries after a restart', async () => {
      const getDeliveriesByWebhook = jest.fn().mockResolvedValue([
        { status: DeliveryStatus.SUCCESS, payload: up },
      ]);
      (storage as unknown as { getDeliveriesByWebhook: jest.Mock }).getDeliveriesByWebhook = getDeliveriesByWebhook;
      await deliver(1, payload);
      expect(hits).toHaveLength(0);
    });

    it('a trigger retry and a resolve due together do not race', async () => {
      delays = [50];
      await Promise.all([deliver(0, up), deliver(1, payload)]);
      expect(hits.map((hit) => hit.body['event_action'])).toEqual(['resolve']);
    });

    it('a resolve queued after a trigger retry still goes out after it', async () => {
      delays = [50];
      await Promise.all([deliver(1, payload), deliver(0, up)]);
      expect(hits.map((hit) => hit.body['event_action'])).toEqual(['trigger', 'resolve']);
    });

    it('different dedup keys are not serialized against each other', async () => {
      delays = [100];
      const conn2 = {
        ...payload,
        id: 'p2',
        instance: { host: 'localhost', port: 6379, connectionId: 'conn-2' },
      };
      let firstDone = false;
      const first = service.sendWebhook(hook(), 'd1', payload, 0).then(() => (firstDone = true));
      const second = service.sendWebhook(hook(), 'd2', conn2, 0);
      await second;
      expect(firstDone).toBe(false);
      await first;
      expect(hits.map((hit) => hit.body['dedup_key'])).toEqual([
        'betterdb:conn-1:instance.down',
        'betterdb:conn-2:instance.down',
      ]);
    });

    it('first attempt does not read the delivery before sending', async () => {
      await service.sendWebhook(hook(), 'd1', payload, 0);
      expect(hits).toHaveLength(1);
      // only updateDelivery's own read remains
      expect(storage.getDelivery).toHaveBeenCalledTimes(1);
    });

    it('restart fallback finds a resolve older than 50 rows', async () => {
      const filler = { status: DeliveryStatus.SUCCESS, payload: { ...payload, id: 'other' } };
      const rows = Array.from({ length: 120 }, (_, i) =>
        i === 110 ? { status: DeliveryStatus.SUCCESS, payload: up } : filler,
      );
      const getDeliveriesByWebhook = jest
        .fn()
        .mockImplementation((_id: string, limit: number, offset: number) =>
          Promise.resolve(rows.slice(offset, offset + limit)),
        );
      storage.getDeliveriesByWebhook = getDeliveriesByWebhook;
      await deliver(1, payload);
      expect(hits).toHaveLength(0);
      expect(getDeliveriesByWebhook).toHaveBeenCalledWith('wh-1', 100, 0);
      expect(getDeliveriesByWebhook).toHaveBeenCalledWith('wh-1', 100, 100);
    });

    it('never blocks a delivery when the check fails', async () => {
      (storage as unknown as { getDeliveriesByWebhook: jest.Mock }).getDeliveriesByWebhook = jest
        .fn()
        .mockRejectedValue(new Error('db down'));
      await deliver(1, payload);
      expect(hits).toHaveLength(1);
    });
  });

  describe('shared send helpers', () => {
    type Poster = { post: (...args: unknown[]) => Promise<Response> };

    it('postWithTimeout aborts and clears its timer', async () => {
      jest.useFakeTimers();
      try {
        jest.spyOn(service as unknown as Poster, 'post').mockImplementation(
          (...args: unknown[]) =>
            new Promise<Response>((_resolve, reject) => {
              (args[3] as AbortSignal).addEventListener('abort', () =>
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              );
            }),
        );
        const pending = (
          service as unknown as {
            postWithTimeout: (url: string, headers: Record<string, string>, body: string, ms: number) => Promise<Response>;
          }
        ).postWithTimeout('http://127.0.0.1/x', {}, '{}', 1000);
        const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        jest.advanceTimersByTime(1000);
        await assertion;
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('trigger, resolve and delivery send identical header sets', async () => {
      const signing = new WebhookDispatcherService(
        storage as unknown as StoragePort,
        { generateSignature: jest.fn((content: string) => `sig:${content}`) } as unknown as WebhooksService,
        { get: jest.fn((key: string, fallback?: unknown) => fallback) } as unknown as ConfigService,
      );
      const post = jest
        .spyOn(signing as unknown as Poster, 'post')
        .mockImplementation(() => Promise.resolve(new Response('{}', { status: 202 })));
      const custom = hook({ headers: { 'X-Custom': '1' } });

      await signing.sendWebhook(custom, 'd1', payload);
      await signing.testWebhook(custom);

      expect(post).toHaveBeenCalledTimes(3);
      const [delivery, trigger, resolve] = post.mock.calls.map((call) => call[1] as Record<string, string>);
      // Trigger and resolve of a test are the same request apart from the body signature.
      expect(Object.entries(resolve).filter(([k]) => k !== 'X-Webhook-Signature')).toEqual(
        Object.entries(trigger).filter(([k]) => k !== 'X-Webhook-Signature'),
      );
      for (const headers of [delivery, trigger, resolve]) {
        expect(Object.keys(headers)).toEqual(
          expect.arrayContaining([
            'Content-Type',
            'User-Agent',
            'X-Webhook-Signature',
            'X-Webhook-Timestamp',
            'X-Webhook-Id',
            'X-Webhook-Event',
            'X-Custom',
          ]),
        );
      }
      expect(delivery['X-Webhook-Delivery-Id']).toBe('d1');
      expect(trigger['X-Webhook-Test']).toBe('true');
      expect(new Set([delivery, trigger, resolve].map((h) => h['X-Webhook-Signature'])).size).toBe(3);
    });
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
