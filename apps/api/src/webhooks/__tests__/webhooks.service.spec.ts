import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { WebhooksService } from '../webhooks.service';
import { StoragePort } from '../../common/interfaces/storage-port.interface';
import { LicenseService } from '@proprietary/license';
import { WebhookEventType, Tier } from '@betterdb/shared';

describe('WebhooksService', () => {
  let service: WebhooksService;
  let storageClient: jest.Mocked<StoragePort>;
  let licenseService: jest.Mocked<LicenseService>;

  beforeEach(async () => {
    storageClient = {
      createWebhook: jest.fn(),
      getWebhook: jest.fn(),
      getWebhooksByInstance: jest.fn(),
      getWebhooksByEvent: jest.fn(),
      updateWebhook: jest.fn(),
      deleteWebhook: jest.fn(),
      getDeliveriesByWebhook: jest.fn(),
      getDelivery: jest.fn(),
      pruneOldDeliveries: jest.fn(),
    } as any;

    licenseService = {
      getLicenseTier: jest.fn().mockReturnValue(Tier.community),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        {
          provide: 'STORAGE_CLIENT',
          useValue: storageClient,
        },
        {
          provide: LicenseService,
          useValue: licenseService,
        },
      ],
    }).compile();

    service = module.get<WebhooksService>(WebhooksService);
  });

  describe('SSRF Protection', () => {
    beforeEach(() => {
      // Mock production environment for SSRF tests
      process.env.NODE_ENV = 'production';
    });

    it('should reject localhost URLs in production', async () => {
      await expect(
        service.createWebhook({
          name: 'Test',
          url: 'http://localhost:3000/webhook',
          events: ['instance.down'] as any,
        })
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject 127.0.0.1 URLs', async () => {
      await expect(
        service.createWebhook({
          name: 'Test',
          url: 'http://127.0.0.1:3000/webhook',
          events: ['instance.down'] as any,
        })
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject 10.x.x.x private IPs', async () => {
      await expect(
        service.createWebhook({
          name: 'Test',
          url: 'http://10.0.0.1/webhook',
          events: ['instance.down'] as any,
        })
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject 172.16-31.x.x private IPs', async () => {
      await expect(
        service.createWebhook({
          name: 'Test',
          url: 'http://172.16.0.1/webhook',
          events: ['instance.down'] as any,
        })
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject 192.168.x.x private IPs', async () => {
      await expect(
        service.createWebhook({
          name: 'Test',
          url: 'http://192.168.1.1/webhook',
          events: ['instance.down'] as any,
        })
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject IPv6 localhost', async () => {
      await expect(
        service.createWebhook({
          name: 'Test',
          url: 'http://[::1]/webhook',
          events: ['instance.down'] as any,
        })
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject link-local IPs', async () => {
      await expect(
        service.createWebhook({
          name: 'Test',
          url: 'http://169.254.1.1/webhook',
          events: ['instance.down'] as any,
        })
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject non-HTTP(S) protocols', async () => {
      await expect(
        service.createWebhook({
          name: 'Test',
          url: 'file:///etc/passwd',
          events: ['instance.down'] as any,
        })
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Secret Generation', () => {
    it('should generate secret with whsec_ prefix', () => {
      const secret = service.generateSecret();
      expect(secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    });

    it('should generate unique secrets', () => {
      const secret1 = service.generateSecret();
      const secret2 = service.generateSecret();
      expect(secret1).not.toBe(secret2);
    });
  });

  describe('Signature Generation and Verification', () => {
    it('should generate consistent signatures', () => {
      const payload = JSON.stringify({ test: 'data' });
      const secret = 'test-secret';
      const sig1 = service.generateSignature(payload, secret);
      const sig2 = service.generateSignature(payload, secret);
      expect(sig1).toBe(sig2);
    });

    it('should verify valid signatures', () => {
      const payload = JSON.stringify({ test: 'data' });
      const secret = 'test-secret';
      const signature = service.generateSignature(payload, secret);
      expect(service.verifySignature(payload, signature, secret)).toBe(true);
    });

    it('should reject invalid signatures', () => {
      const payload = JSON.stringify({ test: 'data' });
      const secret = 'test-secret';
      const invalidSignature = 'invalid-signature';
      expect(service.verifySignature(payload, invalidSignature, secret)).toBe(false);
    });

    it('should reject signatures with wrong secret', () => {
      const payload = JSON.stringify({ test: 'data' });
      const signature = service.generateSignature(payload, 'secret1');
      expect(service.verifySignature(payload, signature, 'secret2')).toBe(false);
    });
  });

  describe('Secret Redaction', () => {
    it('should redact webhook secret', () => {
      const webhook = {
        id: '123',
        name: 'Test',
        url: 'https://example.com',
        secret: 'whsec_1234567890abcdef',
        enabled: true,
        events: [],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const redacted = service.redactSecret(webhook);
      expect(redacted.secret).toBe('whsec_1234***');
    });

    it('should handle webhooks without secrets', () => {
      const webhook = {
        id: '123',
        name: 'Test',
        url: 'https://example.com',
        enabled: true,
        events: [],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const redacted = service.redactSecret(webhook as any);
      expect(redacted.secret).toBeUndefined();
    });
  });

  describe('Tier Validation', () => {
    beforeEach(() => {
      // Reset to non-production environment for tier validation tests
      process.env.NODE_ENV = 'test';
      storageClient.createWebhook.mockResolvedValue({
        id: '123',
        name: 'Test',
        url: 'https://example.com/webhook',
        secret: 'whsec_test',
        enabled: true,
        events: [],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);
      storageClient.updateWebhook.mockResolvedValue({
        id: '123',
        name: 'Test',
        url: 'https://example.com/webhook',
        secret: 'whsec_test',
        enabled: true,
        events: [],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);
    });

    describe('Community Tier', () => {
      beforeEach(() => {
        licenseService.getLicenseTier.mockReturnValue(Tier.community);
      });

      it('should allow community events', async () => {
        await expect(
          service.createWebhook({
            name: 'Test',
            url: 'https://example.com/webhook',
            events: [WebhookEventType.INSTANCE_DOWN, WebhookEventType.MEMORY_CRITICAL],
          })
        ).resolves.toBeDefined();
      });

      it('should reject pro events', async () => {
        await expect(
          service.createWebhook({
            name: 'Test',
            url: 'https://example.com/webhook',
            events: [WebhookEventType.SLOWLOG_THRESHOLD],
          })
        ).rejects.toThrow(ForbiddenException);
      });

      it('should reject enterprise events', async () => {
        await expect(
          service.createWebhook({
            name: 'Test',
            url: 'https://example.com/webhook',
            events: [WebhookEventType.COMPLIANCE_ALERT],
          })
        ).rejects.toThrow(ForbiddenException);
      });

      it('should reject mixed community and pro events', async () => {
        await expect(
          service.createWebhook({
            name: 'Test',
            url: 'https://example.com/webhook',
            events: [WebhookEventType.INSTANCE_DOWN, WebhookEventType.ANOMALY_DETECTED],
          })
        ).rejects.toThrow(ForbiddenException);
      });

      it('should provide helpful error message with required tier', async () => {
        await expect(
          service.createWebhook({
            name: 'Test',
            url: 'https://example.com/webhook',
            events: [WebhookEventType.SLOWLOG_THRESHOLD],
          })
        ).rejects.toThrow(/requires PRO tier/);
      });
    });

    describe('Pro Tier', () => {
      beforeEach(() => {
        licenseService.getLicenseTier.mockReturnValue(Tier.pro);
      });

      it('should allow community events', async () => {
        await expect(
          service.createWebhook({
            name: 'Test',
            url: 'https://example.com/webhook',
            events: [WebhookEventType.INSTANCE_DOWN, WebhookEventType.MEMORY_CRITICAL],
          })
        ).resolves.toBeDefined();
      });

      it('should allow pro events', async () => {
        await expect(
          service.createWebhook({
            name: 'Test',
            url: 'https://example.com/webhook',
            events: [WebhookEventType.SLOWLOG_THRESHOLD, WebhookEventType.ANOMALY_DETECTED],
          })
        ).resolves.toBeDefined();
      });

      it('should allow mixed community and pro events', async () => {
        await expect(
          service.createWebhook({
            name: 'Test',
            url: 'https://example.com/webhook',
            events: [WebhookEventType.INSTANCE_DOWN, WebhookEventType.SLOWLOG_THRESHOLD],
          })
        ).resolves.toBeDefined();
      });

      it('should reject enterprise events', async () => {
        await expect(
          service.createWebhook({
            name: 'Test',
            url: 'https://example.com/webhook',
            events: [WebhookEventType.COMPLIANCE_ALERT],
          })
        ).rejects.toThrow(ForbiddenException);
      });

      it('should provide helpful error message for enterprise events', async () => {
        await expect(
          service.createWebhook({
            name: 'Test',
            url: 'https://example.com/webhook',
            events: [WebhookEventType.AUDIT_POLICY_VIOLATION],
          })
        ).rejects.toThrow(/requires ENTERPRISE tier/);
      });
    });

    describe('Enterprise Tier', () => {
      beforeEach(() => {
        licenseService.getLicenseTier.mockReturnValue(Tier.enterprise);
      });

      it('should allow community events', async () => {
        await expect(
          service.createWebhook({
            name: 'Test',
            url: 'https://example.com/webhook',
            events: [WebhookEventType.INSTANCE_DOWN, WebhookEventType.MEMORY_CRITICAL],
          })
        ).resolves.toBeDefined();
      });

      it('should allow pro events', async () => {
        await expect(
          service.createWebhook({
            name: 'Test',
            url: 'https://example.com/webhook',
            events: [WebhookEventType.SLOWLOG_THRESHOLD, WebhookEventType.ANOMALY_DETECTED],
          })
        ).resolves.toBeDefined();
      });

      it('should allow enterprise events', async () => {
        await expect(
          service.createWebhook({
            name: 'Test',
            url: 'https://example.com/webhook',
            events: [WebhookEventType.COMPLIANCE_ALERT, WebhookEventType.AUDIT_POLICY_VIOLATION],
          })
        ).resolves.toBeDefined();
      });

      it('should allow all event types', async () => {
        await expect(
          service.createWebhook({
            name: 'Test',
            url: 'https://example.com/webhook',
            events: [
              WebhookEventType.INSTANCE_DOWN,
              WebhookEventType.SLOWLOG_THRESHOLD,
              WebhookEventType.COMPLIANCE_ALERT,
            ],
          })
        ).resolves.toBeDefined();
      });
    });

    describe('Update Webhook Tier Validation', () => {
      it('should validate events on update for community tier', async () => {
        licenseService.getLicenseTier.mockReturnValue(Tier.community);

        await expect(
          service.updateWebhook('123', {
            events: [WebhookEventType.SLOWLOG_THRESHOLD],
          })
        ).rejects.toThrow(ForbiddenException);
      });

      it('should allow valid events on update', async () => {
        licenseService.getLicenseTier.mockReturnValue(Tier.pro);

        await expect(
          service.updateWebhook('123', {
            events: [WebhookEventType.INSTANCE_DOWN, WebhookEventType.SLOWLOG_THRESHOLD],
          })
        ).resolves.toBeDefined();
      });

      it('should not validate events if not provided in update', async () => {
        licenseService.getLicenseTier.mockReturnValue(Tier.community);

        await expect(
          service.updateWebhook('123', {
            name: 'New Name',
          })
        ).resolves.toBeDefined();
      });
    });

    describe('getAllowedEvents', () => {
      it('should return community tier events for community users', () => {
        licenseService.getLicenseTier.mockReturnValue(Tier.community);

        const result = service.getAllowedEvents();

        expect(result.tier).toBe(Tier.community);
        expect(result.allowedEvents).toContain(WebhookEventType.INSTANCE_DOWN);
        expect(result.allowedEvents).toContain(WebhookEventType.MEMORY_CRITICAL);
        expect(result.lockedEvents).toContain(WebhookEventType.SLOWLOG_THRESHOLD);
        expect(result.lockedEvents).toContain(WebhookEventType.COMPLIANCE_ALERT);
      });

      it('should return pro tier events for pro users', () => {
        licenseService.getLicenseTier.mockReturnValue(Tier.pro);

        const result = service.getAllowedEvents();

        expect(result.tier).toBe(Tier.pro);
        expect(result.allowedEvents).toContain(WebhookEventType.INSTANCE_DOWN);
        expect(result.allowedEvents).toContain(WebhookEventType.SLOWLOG_THRESHOLD);
        expect(result.lockedEvents).toContain(WebhookEventType.COMPLIANCE_ALERT);
        expect(result.lockedEvents).not.toContain(WebhookEventType.INSTANCE_DOWN);
      });

      it('should return all events for enterprise users', () => {
        licenseService.getLicenseTier.mockReturnValue(Tier.enterprise);

        const result = service.getAllowedEvents();

        expect(result.tier).toBe(Tier.enterprise);
        expect(result.allowedEvents).toContain(WebhookEventType.INSTANCE_DOWN);
        expect(result.allowedEvents).toContain(WebhookEventType.SLOWLOG_THRESHOLD);
        expect(result.allowedEvents).toContain(WebhookEventType.COMPLIANCE_ALERT);
        expect(result.lockedEvents).toHaveLength(0);
      });

      it('should default to community tier if no license service', () => {
        // Create service without license service
        const serviceWithoutLicense = new WebhooksService(storageClient, undefined);

        const result = serviceWithoutLicense.getAllowedEvents();

        expect(result.tier).toBe(Tier.community);
        expect(result.allowedEvents).toContain(WebhookEventType.INSTANCE_DOWN);
        expect(result.lockedEvents).toContain(WebhookEventType.SLOWLOG_THRESHOLD);
      });
    });
  });
});
