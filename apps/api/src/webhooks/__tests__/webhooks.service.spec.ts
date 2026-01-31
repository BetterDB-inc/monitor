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
    const createWebhookWithSecret = (secret?: string) => ({
      id: '123',
      name: 'Test',
      url: 'https://example.com',
      secret,
      enabled: true,
      events: [],
      headers: {},
      retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    it('should redact whsec_ prefixed secret showing prefix + 4 chars', () => {
      const webhook = createWebhookWithSecret('whsec_1234567890abcdef');
      const redacted = service.redactSecret(webhook);
      expect(redacted.secret).toBe('whsec_1234***');
    });

    it('should redact short whsec_ secret showing all available chars', () => {
      const webhook = createWebhookWithSecret('whsec_ab');
      const redacted = service.redactSecret(webhook);
      expect(redacted.secret).toBe('whsec_ab***');
    });

    it('should redact non-prefixed long secret (8+ chars) showing 4 chars', () => {
      const webhook = createWebhookWithSecret('mysupersecret');
      const redacted = service.redactSecret(webhook);
      expect(redacted.secret).toBe('mysu***');
    });

    it('should redact non-prefixed short secret (<8 chars) showing 2 chars', () => {
      const webhook = createWebhookWithSecret('short');
      const redacted = service.redactSecret(webhook);
      expect(redacted.secret).toBe('sh***');
    });

    it('should redact very short secret showing 2 chars', () => {
      const webhook = createWebhookWithSecret('ab');
      const redacted = service.redactSecret(webhook);
      expect(redacted.secret).toBe('ab***');
    });

    it('should handle empty string secret', () => {
      const webhook = createWebhookWithSecret('');
      const redacted = service.redactSecret(webhook as any);
      // Empty string is falsy, so it returns the webhook unchanged
      expect(redacted.secret).toBe('');
    });

    it('should handle webhooks without secrets', () => {
      const webhook = createWebhookWithSecret(undefined);
      const redacted = service.redactSecret(webhook as any);
      expect(redacted.secret).toBeUndefined();
    });

    it('should not modify the original webhook object', () => {
      const webhook = createWebhookWithSecret('whsec_secret123');
      const originalSecret = webhook.secret;
      service.redactSecret(webhook);
      expect(webhook.secret).toBe(originalSecret);
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

    describe('Per-Webhook Configuration', () => {
      beforeEach(() => {
        process.env.NODE_ENV = 'test';
        licenseService.getLicenseTier.mockReturnValue(Tier.community);
      });

      it('should create webhook with deliveryConfig', async () => {
        storageClient.createWebhook.mockResolvedValue({
          id: '123',
          name: 'Config Test',
          url: 'https://example.com/webhook',
          secret: 'whsec_test',
          enabled: true,
          events: [WebhookEventType.INSTANCE_DOWN],
          headers: {},
          retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
          deliveryConfig: { timeoutMs: 15000, maxResponseBodyBytes: 50000 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        const result = await service.createWebhook({
          name: 'Config Test',
          url: 'https://example.com/webhook',
          events: [WebhookEventType.INSTANCE_DOWN],
          deliveryConfig: { timeoutMs: 15000, maxResponseBodyBytes: 50000 },
        });

        expect(storageClient.createWebhook).toHaveBeenCalledWith(
          expect.objectContaining({
            deliveryConfig: { timeoutMs: 15000, maxResponseBodyBytes: 50000 },
          })
        );
        expect(result.deliveryConfig).toEqual({ timeoutMs: 15000, maxResponseBodyBytes: 50000 });
      });

      it('should create webhook with alertConfig', async () => {
        storageClient.createWebhook.mockResolvedValue({
          id: '123',
          name: 'Alert Config Test',
          url: 'https://example.com/webhook',
          secret: 'whsec_test',
          enabled: true,
          events: [WebhookEventType.MEMORY_CRITICAL],
          headers: {},
          retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
          alertConfig: { hysteresisFactor: 0.85 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        const result = await service.createWebhook({
          name: 'Alert Config Test',
          url: 'https://example.com/webhook',
          events: [WebhookEventType.MEMORY_CRITICAL],
          alertConfig: { hysteresisFactor: 0.85 },
        });

        expect(storageClient.createWebhook).toHaveBeenCalledWith(
          expect.objectContaining({
            alertConfig: { hysteresisFactor: 0.85 },
          })
        );
        expect(result.alertConfig).toEqual({ hysteresisFactor: 0.85 });
      });

      it('should create webhook with thresholds', async () => {
        storageClient.createWebhook.mockResolvedValue({
          id: '123',
          name: 'Thresholds Test',
          url: 'https://example.com/webhook',
          secret: 'whsec_test',
          enabled: true,
          events: [WebhookEventType.MEMORY_CRITICAL],
          headers: {},
          retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
          thresholds: { memoryCriticalPercent: 75, connectionCriticalPercent: 80 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        const result = await service.createWebhook({
          name: 'Thresholds Test',
          url: 'https://example.com/webhook',
          events: [WebhookEventType.MEMORY_CRITICAL],
          thresholds: { memoryCriticalPercent: 75, connectionCriticalPercent: 80 },
        });

        expect(storageClient.createWebhook).toHaveBeenCalledWith(
          expect.objectContaining({
            thresholds: { memoryCriticalPercent: 75, connectionCriticalPercent: 80 },
          })
        );
        expect(result.thresholds).toEqual({ memoryCriticalPercent: 75, connectionCriticalPercent: 80 });
      });

      it('should create webhook with all config fields', async () => {
        const fullConfig = {
          deliveryConfig: { timeoutMs: 10000, maxResponseBodyBytes: 25000 },
          alertConfig: { hysteresisFactor: 0.8 },
          thresholds: { memoryCriticalPercent: 85, slowlogCount: 50 },
        };

        storageClient.createWebhook.mockResolvedValue({
          id: '123',
          name: 'Full Config',
          url: 'https://example.com/webhook',
          secret: 'whsec_test',
          enabled: true,
          events: [WebhookEventType.INSTANCE_DOWN],
          headers: {},
          retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
          ...fullConfig,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        const result = await service.createWebhook({
          name: 'Full Config',
          url: 'https://example.com/webhook',
          events: [WebhookEventType.INSTANCE_DOWN],
          ...fullConfig,
        });

        expect(storageClient.createWebhook).toHaveBeenCalledWith(
          expect.objectContaining(fullConfig)
        );
        expect(result.deliveryConfig).toEqual(fullConfig.deliveryConfig);
        expect(result.alertConfig).toEqual(fullConfig.alertConfig);
        expect(result.thresholds).toEqual(fullConfig.thresholds);
      });

      it('should update webhook with deliveryConfig', async () => {
        storageClient.updateWebhook.mockResolvedValue({
          id: '123',
          name: 'Updated',
          url: 'https://example.com/webhook',
          secret: 'whsec_test',
          enabled: true,
          events: [WebhookEventType.INSTANCE_DOWN],
          headers: {},
          retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
          deliveryConfig: { timeoutMs: 5000 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        const result = await service.updateWebhook('123', {
          deliveryConfig: { timeoutMs: 5000 },
        });

        expect(result.deliveryConfig).toEqual({ timeoutMs: 5000 });
      });

      it('should update webhook with thresholds', async () => {
        storageClient.updateWebhook.mockResolvedValue({
          id: '123',
          name: 'Updated',
          url: 'https://example.com/webhook',
          secret: 'whsec_test',
          enabled: true,
          events: [WebhookEventType.MEMORY_CRITICAL],
          headers: {},
          retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
          thresholds: { memoryCriticalPercent: 70 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        const result = await service.updateWebhook('123', {
          thresholds: { memoryCriticalPercent: 70 },
        });

        expect(result.thresholds).toEqual({ memoryCriticalPercent: 70 });
      });

      it('should handle undefined config fields in create', async () => {
        storageClient.createWebhook.mockResolvedValue({
          id: '123',
          name: 'No Config',
          url: 'https://example.com/webhook',
          secret: 'whsec_test',
          enabled: true,
          events: [WebhookEventType.INSTANCE_DOWN],
          headers: {},
          retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        const result = await service.createWebhook({
          name: 'No Config',
          url: 'https://example.com/webhook',
          events: [WebhookEventType.INSTANCE_DOWN],
        });

        expect(storageClient.createWebhook).toHaveBeenCalledWith(
          expect.objectContaining({
            deliveryConfig: undefined,
            alertConfig: undefined,
            thresholds: undefined,
          })
        );
        expect(result.deliveryConfig).toBeUndefined();
        expect(result.alertConfig).toBeUndefined();
        expect(result.thresholds).toBeUndefined();
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
