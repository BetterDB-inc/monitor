import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { EntitlementService } from '../entitlement.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Tier, EntitlementRequest } from '@betterdb/shared';

type MockPrismaService = {
  license: {
    findUnique: jest.Mock;
  };
};

describe('EntitlementService', () => {
  let service: EntitlementService;
  let prisma: MockPrismaService;

  beforeEach(async () => {
    const mockPrisma: MockPrismaService = {
      license: {
        findUnique: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntitlementService,
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
      ],
    }).compile();

    service = module.get<EntitlementService>(EntitlementService);
    prisma = module.get(PrismaService);
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

    it('should throw UnauthorizedException for invalid license key', async () => {
      (prisma.license.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.validateLicense({
          licenseKey: 'invalid-key-12345678',
          instanceId: 'test-instance',
          eventType: 'license_check',
        }),
      ).rejects.toThrow(UnauthorizedException);
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
