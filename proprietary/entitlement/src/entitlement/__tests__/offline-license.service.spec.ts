import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Tier } from '@betterdb/shared';
import { OfflineLicenseService } from '../offline-license.service';
import { LicenseSigningService } from '../license-signing.service';
import { PrismaService } from '../../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('OfflineLicenseService', () => {
  let service: OfflineLicenseService;
  let prisma: {
    customer: { findFirst: Mock };
    license: { findUnique: Mock };
    offlineLicenseIssuance: { create: Mock };
    licenseKeyReveal: { create: Mock };
  };
  let signing: { isConfigured: boolean; signLicenseToken: Mock };

  const baseLicense = {
    id: 'license-1',
    key: 'btdb_0123456789abcdef',
    tier: 'pro',
    instanceLimit: 3,
    active: true,
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
    createdAt: new Date(),
    customer: {
      id: 'customer-1',
      name: 'Acme',
      email: 'Ops@Acme.Test',
    },
  };

  beforeEach(async () => {
    prisma = {
      customer: { findFirst: vi.fn() },
      license: { findUnique: vi.fn() },
      offlineLicenseIssuance: { create: vi.fn().mockResolvedValue({}) },
      licenseKeyReveal: { create: vi.fn().mockResolvedValue({}) },
    };
    signing = {
      isConfigured: true,
      signLicenseToken: vi.fn().mockReturnValue({
        token: 'signed.offline.token',
        jti: 'jti-1',
        kid: 'lic-test',
        expiresAt: baseLicense.expiresAt,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OfflineLicenseService,
        { provide: PrismaService, useValue: prisma },
        { provide: LicenseSigningService, useValue: signing },
      ],
    }).compile();

    service = module.get(OfflineLicenseService);
  });

  describe('listLicensesByEmail', () => {
    it('returns [] for unknown customers', async () => {
      prisma.customer.findFirst.mockResolvedValue(null);
      expect(await service.listLicensesByEmail('nobody@example.com')).toEqual([]);
    });

    it('summarizes licenses with masked keys and eligibility', async () => {
      prisma.customer.findFirst.mockResolvedValue({
        id: 'customer-1',
        email: 'ops@acme.test',
        licenses: [
          { ...baseLicense },
          { ...baseLicense, id: 'license-2', tier: 'community', key: 'btdb_zzzz' },
          { ...baseLicense, id: 'license-3', active: false },
        ],
      });

      const result = await service.listLicensesByEmail('ops@acme.test');

      expect(result).toHaveLength(3);
      expect(result[0]).toMatchObject({
        id: 'license-1',
        tier: Tier.pro,
        keyLast4: 'cdef',
        offlineEligible: true,
      });
      expect(result[1].offlineEligible).toBe(false); // community
      expect(result[2].offlineEligible).toBe(false); // inactive
      expect(result.some((l) => 'key' in l)).toBe(false);
    });
  });

  describe('revealLicenseKey', () => {
    it('returns the full key to the owner (case-insensitive email)', async () => {
      prisma.license.findUnique.mockResolvedValue(baseLicense);
      expect(await service.revealLicenseKey('license-1', 'OPS@acme.test')).toEqual({
        key: 'btdb_0123456789abcdef',
      });
    });

    it('audits every reveal', async () => {
      prisma.license.findUnique.mockResolvedValue(baseLicense);
      await service.revealLicenseKey('license-1', 'OPS@acme.test');

      expect(prisma.licenseKeyReveal.create).toHaveBeenCalledWith({
        data: { licenseId: 'license-1', licenseKeyLast4: 'cdef', revealedToEmail: 'ops@acme.test' },
      });
    });

    it('does not audit refused reveals', async () => {
      prisma.license.findUnique.mockResolvedValue(baseLicense);
      await expect(service.revealLicenseKey('license-1', 'other@evil.test')).rejects.toThrow();
      expect(prisma.licenseKeyReveal.create).not.toHaveBeenCalled();
    });

    it('refuses to reveal a key to a non-owner', async () => {
      prisma.license.findUnique.mockResolvedValue(baseLicense);
      await expect(service.revealLicenseKey('license-1', 'other@evil.test')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws NotFound for unknown license', async () => {
      prisma.license.findUnique.mockResolvedValue(null);
      await expect(service.revealLicenseKey('nope', 'ops@acme.test')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('issueOfflineToken', () => {
    it('throws NotFound for unknown license', async () => {
      prisma.license.findUnique.mockResolvedValue(null);
      await expect(service.issueOfflineToken('nope', 'ops@acme.test')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws Forbidden when the requester does not own the license', async () => {
      prisma.license.findUnique.mockResolvedValue(baseLicense);
      await expect(service.issueOfflineToken('license-1', 'other@evil.test')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('matches customer email case-insensitively', async () => {
      prisma.license.findUnique.mockResolvedValue(baseLicense);
      const result = await service.issueOfflineToken('license-1', 'ops@acme.test');
      expect(result.token).toBe('signed.offline.token');
    });

    it('rejects deactivated licenses', async () => {
      prisma.license.findUnique.mockResolvedValue({ ...baseLicense, active: false });
      await expect(service.issueOfflineToken('license-1', 'ops@acme.test')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects community licenses', async () => {
      prisma.license.findUnique.mockResolvedValue({ ...baseLicense, tier: 'community' });
      await expect(service.issueOfflineToken('license-1', 'ops@acme.test')).rejects.toThrow(
        /Pro and Enterprise/,
      );
    });

    it('rejects expired licenses', async () => {
      prisma.license.findUnique.mockResolvedValue({
        ...baseLicense,
        expiresAt: new Date(Date.now() - DAY_MS),
      });
      await expect(service.issueOfflineToken('license-1', 'ops@acme.test')).rejects.toThrow(
        /expired/,
      );
    });

    it('throws ServiceUnavailable when signing is unconfigured', async () => {
      signing.isConfigured = false;
      prisma.license.findUnique.mockResolvedValue(baseLicense);
      await expect(service.issueOfflineToken('license-1', 'ops@acme.test')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('uses the license expiry for the token and records the issuance', async () => {
      prisma.license.findUnique.mockResolvedValue(baseLicense);

      // Mixed-case requester: the audit row must store the normalized email
      const result = await service.issueOfflineToken('license-1', 'Ops@Acme.Test');

      const [input, expiresAt] = signing.signLicenseToken.mock.calls[0];
      expect(input).toMatchObject({
        licenseId: 'license-1',
        tier: Tier.pro,
        instanceLimit: 3,
        mode: 'offline',
        // the license's real expiry rides as its own claim, not the token exp
        licenseExpiresAt: baseLicense.expiresAt,
      });
      expect((expiresAt as Date).getTime()).toBe(baseLicense.expiresAt.getTime());

      expect(prisma.offlineLicenseIssuance.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          licenseId: 'license-1',
          // durable identifier that survives a license delete (nulls licenseId)
          licenseKeyLast4: 'cdef',
          jti: 'jti-1',
          kid: 'lic-test',
          issuedToEmail: 'ops@acme.test',
        }),
      });
      expect(result.filename).toBe('betterdb-license-license-1.jwt');
    });

    it('caps perpetual licenses at 366 days', async () => {
      prisma.license.findUnique.mockResolvedValue({ ...baseLicense, expiresAt: null });

      await service.issueOfflineToken('license-1', 'ops@acme.test');

      const expiresAt = signing.signLicenseToken.mock.calls[0][1] as Date;
      const delta = expiresAt.getTime() - Date.now();
      expect(delta).toBeGreaterThan(365 * DAY_MS);
      expect(delta).toBeLessThanOrEqual(366 * DAY_MS + 1000);
    });
  });
});
