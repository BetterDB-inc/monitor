import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { EntitlementService } from '../entitlement.service';
import { LicenseSigningService } from '../license-signing.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Tier, EntitlementRequest } from '@betterdb/shared';

type MockPrismaService = {
  license: {
    findUnique: Mock;
  };
  tenant: {
    findFirst: Mock;
  };
};

type MockLicenseSigningService = {
  isConfigured: boolean;
  signLicenseToken: Mock;
};

describe('EntitlementService', () => {
  let service: EntitlementService;
  let prisma: MockPrismaService;
  let signing: MockLicenseSigningService;

  beforeEach(async () => {
    const mockPrisma: MockPrismaService = {
      license: {
        findUnique: vi.fn(),
      },
      tenant: {
        findFirst: vi.fn(),
      },
    };

    const mockSigning: MockLicenseSigningService = {
      isConfigured: false,
      signLicenseToken: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntitlementService,
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
        {
          provide: LicenseSigningService,
          useValue: mockSigning,
        },
      ],
    }).compile();

    service = module.get<EntitlementService>(EntitlementService);
    prisma = module.get(PrismaService);
    signing = module.get(LicenseSigningService);
  });

  describe('handleKeylessInstance', () => {
    it('should return community tier entitlements for keyless requests', async () => {
      const request: EntitlementRequest = {
        instanceId: 'test-instance-id-123456',
        eventType: 'license_check',
        stats: {
          version: '1.0.0',
          platform: 'linux',
          arch: 'x64',
          nodeVersion: 'v20.0.0',
        },
      };

      const result = await service.handleKeylessInstance(request);

      expect(result).toEqual({
        valid: true,
        tier: Tier.community,
        expiresAt: null,
      });
    });

    it('should handle requests with missing stats', async () => {
      const request: EntitlementRequest = {
        instanceId: 'test-instance-id',
        eventType: 'license_check',
      };

      const result = await service.handleKeylessInstance(request);

      expect(result.valid).toBe(true);
      expect(result.tier).toBe(Tier.community);
    });

    it('should handle requests with partial stats', async () => {
      const request: EntitlementRequest = {
        instanceId: 'test-instance-id',
        eventType: 'license_check',
        stats: {
          version: '1.0.0',
          // Missing platform, arch, nodeVersion
        },
      };

      const result = await service.handleKeylessInstance(request);

      expect(result.valid).toBe(true);
      expect(result.tier).toBe(Tier.community);
    });
  });

  describe('handleCloudInstance', () => {
    const readyTenant = { id: 'tenant-cuid', status: 'ready' };

    it('signs cloud enterprise grants for a known, in-service tenant', async () => {
      prisma.tenant.findFirst.mockResolvedValue(readyTenant);
      signing.isConfigured = true;
      signing.signLicenseToken.mockReturnValue({
        token: 'signed.cloud.token',
        jti: 'jti-cloud',
        kid: 'lic-test',
        expiresAt: new Date(),
      });

      const result = await service.handleCloudInstance({
        tenantId: 'tenant_acme',
        instanceId: 'cloud-instance',
        eventType: 'license_check',
        deploymentMode: 'cloud',
      });

      expect(result.tier).toBe(Tier.enterprise);
      expect(result.token).toBe('signed.cloud.token');
      expect(prisma.tenant.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { dbSchema: 'tenant_acme' } }),
      );
      expect(signing.signLicenseToken).toHaveBeenCalledWith(
        expect.objectContaining({
          licenseId: 'cloud-tenant:tenant_acme',
          tier: Tier.enterprise,
          mode: 'online',
        }),
        expect.any(Date),
      );
    });

    it('refuses enterprise for an unknown tenantId (forged) → community, unsigned', async () => {
      prisma.tenant.findFirst.mockResolvedValue(null);

      const result = await service.handleCloudInstance({
        tenantId: 'tenant_attacker_made_this_up',
        instanceId: 'cloud-instance',
        eventType: 'license_check',
        deploymentMode: 'cloud',
      });

      expect(result.tier).toBe(Tier.community);
      expect(result.token).toBeUndefined();
      expect(signing.signLicenseToken).not.toHaveBeenCalled();
    });

    it('refuses enterprise for a suspended tenant', async () => {
      prisma.tenant.findFirst.mockResolvedValue({ id: 'tenant-cuid', status: 'suspended' });

      const result = await service.handleCloudInstance({
        tenantId: 'tenant_lapsed',
        instanceId: 'cloud-instance',
        eventType: 'license_check',
        deploymentMode: 'cloud',
      });

      expect(result.tier).toBe(Tier.community);
    });

    it('returns an unsigned grant when signing is unconfigured (dev)', async () => {
      prisma.tenant.findFirst.mockResolvedValue(readyTenant);

      const result = await service.handleCloudInstance({
        tenantId: 'tenant_acme',
        instanceId: 'cloud-instance',
        eventType: 'license_check',
        deploymentMode: 'cloud',
      });

      expect(result.tier).toBe(Tier.enterprise);
      expect(result.token).toBeUndefined();
    });
  });

  describe('validateLicense', () => {
    it('should validate a valid license key', async () => {
      const mockLicense = {
        id: 'license-id',
        key: 'valid-license-key-12345',
        tier: 'pro',
        active: true,
        expiresAt: null,
        customer: {
          id: 'customer-id',
          name: 'Test Customer',
          email: 'test@example.com',
        },
      };

      prisma.license.findUnique.mockResolvedValue(mockLicense);

      const result = await service.validateLicense({
        licenseKey: 'valid-license-key-12345',
        instanceId: 'test-instance',
        eventType: 'license_check',
      });

      expect(result.valid).toBe(true);
      expect(result.tier).toBe(Tier.pro);
    });

    it('should return 200 valid:false for an unknown key (not throw) so infra 401s stay distinguishable', async () => {
      (prisma.license.findUnique as Mock).mockResolvedValue(null);

      const result = await service.validateLicense({
        licenseKey: 'invalid-key-12345678',
        instanceId: 'test-instance',
        eventType: 'license_check',
      });

      expect(result.valid).toBe(false);
      expect(result.tier).toBe(Tier.community);
      expect(result.error).toContain('Invalid');
    });

    it('should return community tier for inactive license', async () => {
      const mockLicense = {
        id: 'license-id',
        key: 'valid-license-key-12345',
        tier: 'pro',
        active: false,
        expiresAt: null,
        customer: {
          id: 'customer-id',
          name: 'Test Customer',
          email: 'test@example.com',
        },
      };

      prisma.license.findUnique.mockResolvedValue(mockLicense);

      const result = await service.validateLicense({
        licenseKey: 'valid-license-key-12345',
        instanceId: 'test-instance',
        eventType: 'license_check',
      });

      expect(result.valid).toBe(false);
      expect(result.tier).toBe(Tier.community);
      expect(result.error).toContain('deactivated');
    });

    it('should attach a signed token and instanceLimit when signing is configured', async () => {
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const mockLicense = {
        id: 'license-id',
        key: 'valid-license-key-12345',
        tier: 'pro',
        active: true,
        instanceLimit: 5,
        expiresAt,
        customer: {
          id: 'customer-id',
          name: 'Test Customer',
          email: 'test@example.com',
        },
      };

      prisma.license.findUnique.mockResolvedValue(mockLicense);
      signing.isConfigured = true;
      signing.signLicenseToken.mockReturnValue({
        token: 'signed.jwt.token',
        jti: 'jti-1',
        kid: 'lic-test',
        expiresAt,
      });

      const result = await service.validateLicense({
        licenseKey: 'valid-license-key-12345',
        instanceId: 'test-instance',
        eventType: 'license_check',
      });

      expect(result.token).toBe('signed.jwt.token');
      expect(result.instanceLimit).toBe(5);
      expect(signing.signLicenseToken).toHaveBeenCalledWith(
        expect.objectContaining({ licenseId: 'license-id', tier: Tier.pro, mode: 'online' }),
        expect.any(Date),
      );
    });

    it('should cap the online token expiry at 7 days for long-lived licenses', async () => {
      const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      const mockLicense = {
        id: 'license-id',
        key: 'valid-license-key-12345',
        tier: 'pro',
        active: true,
        instanceLimit: 1,
        expiresAt,
        customer: { id: 'customer-id', name: null, email: 'test@example.com' },
      };

      prisma.license.findUnique.mockResolvedValue(mockLicense);
      signing.isConfigured = true;
      signing.signLicenseToken.mockReturnValue({
        token: 'signed.jwt.token',
        jti: 'jti-1',
        kid: 'lic-test',
        expiresAt,
      });

      await service.validateLicense({
        licenseKey: 'valid-license-key-12345',
        instanceId: 'test-instance',
        eventType: 'license_check',
      });

      const tokenExpiry = signing.signLicenseToken.mock.calls[0][1] as Date;
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      expect(tokenExpiry.getTime()).toBeLessThanOrEqual(Date.now() + sevenDaysMs + 1000);
    });

    it('should not attach a token when signing is unconfigured', async () => {
      const mockLicense = {
        id: 'license-id',
        key: 'valid-license-key-12345',
        tier: 'pro',
        active: true,
        instanceLimit: 1,
        expiresAt: null,
        customer: { id: 'customer-id', name: null, email: 'test@example.com' },
      };

      prisma.license.findUnique.mockResolvedValue(mockLicense);

      const result = await service.validateLicense({
        licenseKey: 'valid-license-key-12345',
        instanceId: 'test-instance',
        eventType: 'license_check',
      });

      expect(result.valid).toBe(true);
      expect(result.token).toBeUndefined();
      expect(signing.signLicenseToken).not.toHaveBeenCalled();
    });

    it('fails transiently (503) rather than returning a valid unsigned paid grant when signing throws', async () => {
      const mockLicense = {
        id: 'license-id',
        key: 'valid-license-key-12345',
        tier: 'pro',
        active: true,
        instanceLimit: 1,
        expiresAt: null,
        customer: { id: 'customer-id', name: null, email: 'test@example.com' },
      };

      prisma.license.findUnique.mockResolvedValue(mockLicense);
      signing.isConfigured = true;
      signing.signLicenseToken.mockImplementation(() => {
        throw new Error('bad key');
      });

      // Monitors refuse unsigned paid grants — a signing failure must surface
      // as a retryable outage, not a valid-but-unsigned pro response.
      await expect(
        service.validateLicense({
          licenseKey: 'valid-license-key-12345',
          instanceId: 'test-instance',
          eventType: 'license_check',
        }),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('should return community tier for expired license', async () => {
      const mockLicense = {
        id: 'license-id',
        key: 'valid-license-key-12345',
        tier: 'pro',
        active: true,
        expiresAt: new Date('2020-01-01'),
        customer: {
          id: 'customer-id',
          name: 'Test Customer',
          email: 'test@example.com',
        },
      };

      prisma.license.findUnique.mockResolvedValue(mockLicense);

      const result = await service.validateLicense({
        licenseKey: 'valid-license-key-12345',
        instanceId: 'test-instance',
        eventType: 'license_check',
      });

      expect(result.valid).toBe(false);
      expect(result.tier).toBe(Tier.community);
      expect(result.error).toContain('expired');
    });
  });
});
