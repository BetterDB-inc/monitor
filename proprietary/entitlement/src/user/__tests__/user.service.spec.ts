import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { UserService } from '../user.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Tenant scoping on id-addressed user operations (GHSA-2rwf-9ffp-8pf2):
 * every tenant pod holds the shared admin bearer, so the ONLY thing keeping
 * one tenant's owner from deleting another tenant's user is the tenantId
 * check in this service. A foreign id must 404 exactly like a missing one.
 */
describe('UserService tenant scoping', () => {
  let service: UserService;
  let prisma: { user: { findUnique: Mock; delete: Mock } };

  const tenantAUser = {
    id: 'user-a1',
    email: 'a@tenant-a.test',
    tenantId: 'tenant-a',
    tenant: { id: 'tenant-a' },
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue(tenantAUser),
        delete: vi.fn().mockResolvedValue(tenantAUser),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [UserService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(UserService);
  });

  describe('getUserForTenant', () => {
    it('returns the user when the tenant matches', async () => {
      await expect(service.getUserForTenant('user-a1', 'tenant-a')).resolves.toEqual(tenantAUser);
    });

    it('404s on a tenant mismatch, indistinguishable from a missing id', async () => {
      await expect(service.getUserForTenant('user-a1', 'tenant-b')).rejects.toThrow(
        NotFoundException,
      );
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getUserForTenant('missing', 'tenant-b')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('skips the check when no tenantId is given (internal admin callers)', async () => {
      await expect(service.getUserForTenant('user-a1')).resolves.toEqual(tenantAUser);
    });

    it('404s on a present-but-empty tenantId (fails closed, not open)', async () => {
      // `?tenantId=` reaches the service as '' — a mismatch, not "unscoped".
      // Only a genuinely absent (undefined) tenantId grants unscoped access.
      await expect(service.getUserForTenant('user-a1', '')).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteUser', () => {
    it('deletes within the same tenant', async () => {
      await expect(service.deleteUser('user-a1', 'tenant-a')).resolves.toEqual({ deleted: true });
      expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'user-a1' } });
    });

    it('404s and does NOT delete on a cross-tenant id', async () => {
      await expect(service.deleteUser('user-a1', 'tenant-b')).rejects.toThrow(NotFoundException);
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it('still deletes unscoped when no tenantId is given', async () => {
      await expect(service.deleteUser('user-a1')).resolves.toEqual({ deleted: true });
      expect(prisma.user.delete).toHaveBeenCalled();
    });
  });
});
