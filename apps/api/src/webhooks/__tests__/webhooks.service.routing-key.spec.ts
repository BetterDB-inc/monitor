import { BadRequestException } from '@nestjs/common';
import { Tier, WebhookEventType, WebhookPayloadFormat, type Webhook } from '@betterdb/shared';
import { WebhooksService } from '../webhooks.service';
import type { StoragePort } from '../../common/interfaces/storage-port.interface';
import type { ConnectionRegistry } from '../../connections/connection-registry.service';
import type { LicenseService } from '@proprietary/licenses';

const ROUTING_KEY = 'R0123456789ABCDEFGHIJKLMNOPQRSTU';
const OTHER_KEY = 'Z9876543210ZYXWVUTSRQPONMLKJIHGF';

function stored(overrides: Partial<Webhook> = {}): Webhook {
  return {
    id: 'wh-1',
    name: 'Pager',
    url: 'https://events.pagerduty.com/v2/enqueue',
    secret: 'whsec_abcdefghijkl',
    enabled: true,
    events: [WebhookEventType.INSTANCE_DOWN],
    headers: {},
    retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
    payloadFormat: WebhookPayloadFormat.PAGERDUTY,
    routingKey: ROUTING_KEY,
    connectionId: 'conn-1',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('WebhooksService routing key and credential handling', () => {
  let storage: { createWebhook: jest.Mock; getWebhook: jest.Mock; updateWebhook: jest.Mock };
  let service: WebhooksService;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    storage = {
      createWebhook: jest.fn().mockImplementation((input) => Promise.resolve({ ...input, id: 'wh-1', createdAt: 1, updatedAt: 1 })),
      getWebhook: jest.fn().mockResolvedValue(stored()),
      updateWebhook: jest.fn().mockImplementation((_id, updates) => Promise.resolve({ ...stored(), ...updates })),
    };
    service = new WebhooksService(
      storage as unknown as StoragePort,
      { getDefaultId: jest.fn().mockReturnValue('conn-1') } as unknown as ConnectionRegistry,
      { getLicenseTier: jest.fn().mockReturnValue(Tier.pro) } as unknown as LicenseService,
    );
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  const create = (overrides: Record<string, unknown> = {}) =>
    service.createWebhook({
      name: 'Pager',
      url: 'https://events.pagerduty.com/v2/enqueue',
      events: [WebhookEventType.INSTANCE_DOWN],
      payloadFormat: WebhookPayloadFormat.PAGERDUTY,
      routingKey: ROUTING_KEY,
      ...overrides,
    } as never);

  describe('create', () => {
    it('stores the routing key for a PagerDuty webhook', async () => {
      await create();
      expect(storage.createWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ payloadFormat: WebhookPayloadFormat.PAGERDUTY, routingKey: ROUTING_KEY }),
      );
    });

    it('requires a routing key for the pagerduty format', async () => {
      await expect(create({ routingKey: undefined })).rejects.toThrow(BadRequestException);
      await expect(create({ routingKey: '' })).rejects.toThrow(/routingKey is required/);
      expect(storage.createWebhook).not.toHaveBeenCalled();
    });

    it('rejects a malformed routing key whatever the format', async () => {
      await expect(create({ routingKey: 'short' })).rejects.toThrow(/32 letters and digits/);
      await expect(
        create({ payloadFormat: WebhookPayloadFormat.GENERIC, routingKey: 'not-a-key' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts a real secret that looks like a placeholder on create', async () => {
      for (const secret of ['ab***', 'whsec_x***']) {
        storage.createWebhook.mockClear();
        await create({ secret });
        expect(storage.createWebhook).toHaveBeenCalledWith(expect.objectContaining({ secret }));
      }
    });

    it('drops the routing key for a non-PagerDuty format', async () => {
      await create({ payloadFormat: WebhookPayloadFormat.TEAMS, routingKey: ROUTING_KEY });
      expect(storage.createWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ payloadFormat: WebhookPayloadFormat.TEAMS, routingKey: undefined }),
      );
    });

    it('rejects an http PagerDuty Events URL for the pagerduty format', async () => {
      await expect(create({ url: 'http://events.pagerduty.com/v2/enqueue' })).rejects.toThrow(
        'PagerDuty webhooks must use https://',
      );
      expect(storage.createWebhook).not.toHaveBeenCalled();
    });

    it('still allows an http relay URL for the pagerduty format', async () => {
      await create({ url: 'http://relay.internal.example.com/pd' });
      expect(storage.createWebhook).toHaveBeenCalledTimes(1);
    });

    it('does not need a routing key for other formats', async () => {
      await create({ payloadFormat: WebhookPayloadFormat.TEAMS, routingKey: undefined });
      expect(storage.createWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ payloadFormat: WebhookPayloadFormat.TEAMS, routingKey: undefined }),
      );
    });
  });

  describe('update', () => {
    it('keeps the stored secret and routing key when the redacted values are sent back', async () => {
      const redacted = service.redactSecret(stored());
      expect(redacted.secret).toBe('whsec_abcd***');
      expect(redacted.routingKey).toBe('R012***');

      await service.updateWebhook('wh-1', {
        name: 'Renamed',
        secret: redacted.secret,
        routingKey: redacted.routingKey,
      } as never);

      const updates = storage.updateWebhook.mock.calls[0][1];
      expect(updates).toEqual({ name: 'Renamed' });
    });

    it('still lets a real new secret and routing key through', async () => {
      await service.updateWebhook('wh-1', { secret: 'whsec_new_secret', routingKey: OTHER_KEY } as never);
      expect(storage.updateWebhook).toHaveBeenCalledWith('wh-1', {
        secret: 'whsec_new_secret',
        routingKey: OTHER_KEY,
      });
    });

    it('treats an empty routing key as "unchanged"', async () => {
      await service.updateWebhook('wh-1', { name: 'x', routingKey: '' } as never);
      expect(storage.updateWebhook.mock.calls[0][1]).toEqual({ name: 'x' });
    });

    it('rejects a routing key that is neither the redacted stored key nor a valid key', async () => {
      await expect(service.updateWebhook('wh-1', { name: 'x', routingKey: 'Z987***' } as never)).rejects.toThrow(
        BadRequestException,
      );
      expect(storage.updateWebhook).not.toHaveBeenCalled();
    });

    it("stores a secret that is not the stored value's redacted form", async () => {
      await service.updateWebhook('wh-1', { name: 'x', secret: 'whsec_zzzz***' } as never);
      expect(storage.updateWebhook.mock.calls[0][1]).toEqual({ name: 'x', secret: 'whsec_zzzz***' });
    });

    it('clears the stored routing key when a PagerDuty webhook is switched to another format', async () => {
      await service.updateWebhook('wh-1', { payloadFormat: WebhookPayloadFormat.SLACK } as never);
      expect(storage.updateWebhook.mock.calls[0][1]).toEqual({
        payloadFormat: WebhookPayloadFormat.SLACK,
        routingKey: null,
      });
    });

    it('drops a routing key sent for a non-PagerDuty format', async () => {
      storage.getWebhook.mockResolvedValue(stored({ payloadFormat: WebhookPayloadFormat.SLACK, routingKey: undefined }));
      await service.updateWebhook('wh-1', { name: 'x', routingKey: ROUTING_KEY } as never);
      expect(storage.updateWebhook.mock.calls[0][1]).toEqual({ name: 'x' });
    });

    it('rejects switching an existing webhook to an http PagerDuty Events URL', async () => {
      await expect(
        service.updateWebhook('wh-1', { url: 'http://events.pagerduty.com/v2/enqueue' } as never),
      ).rejects.toThrow('PagerDuty webhooks must use https://');
      expect(storage.updateWebhook).not.toHaveBeenCalled();
    });

    it('treats null routingKey and secret as "unchanged"', async () => {
      await service.updateWebhook('wh-1', { name: 'x', routingKey: null, secret: null } as never);
      expect(storage.updateWebhook.mock.calls[0][1]).toEqual({ name: 'x' });
    });

    it('refuses to switch a webhook to pagerduty without a routing key', async () => {
      storage.getWebhook.mockResolvedValue(stored({ payloadFormat: WebhookPayloadFormat.GENERIC, routingKey: undefined }));
      await expect(
        service.updateWebhook('wh-1', { payloadFormat: WebhookPayloadFormat.PAGERDUTY } as never),
      ).rejects.toThrow(/routingKey is required/);
      expect(storage.updateWebhook).not.toHaveBeenCalled();
    });

    it('allows switching to pagerduty when the key is supplied in the same update', async () => {
      storage.getWebhook.mockResolvedValue(stored({ payloadFormat: WebhookPayloadFormat.GENERIC, routingKey: undefined }));
      await service.updateWebhook('wh-1', {
        payloadFormat: WebhookPayloadFormat.PAGERDUTY,
        routingKey: ROUTING_KEY,
      } as never);
      expect(storage.updateWebhook).toHaveBeenCalledTimes(1);
    });

    it('rejects a malformed routing key on update', async () => {
      await expect(service.updateWebhook('wh-1', { routingKey: 'bad key' } as never)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('404s for an unknown webhook before writing anything', async () => {
      storage.getWebhook.mockResolvedValue(null);
      await expect(service.updateWebhook('missing', { name: 'x' } as never)).rejects.toThrow(/not found/);
      expect(storage.updateWebhook).not.toHaveBeenCalled();
    });
  });

  describe('redaction', () => {
    it('redacts the routing key and leaves webhooks without one untouched', () => {
      expect(service.redactSecret(stored()).routingKey).toBe('R012***');
      const plain = service.redactSecret(stored({ routingKey: undefined, secret: undefined }));
      expect(plain.routingKey).toBeUndefined();
      expect(plain.secret).toBeUndefined();
    });

    it('does not mutate the stored webhook', () => {
      const original = stored();
      service.redactSecret(original);
      expect(original.routingKey).toBe(ROUTING_KEY);
      expect(original.secret).toBe('whsec_abcdefghijkl');
    });
  });
});
