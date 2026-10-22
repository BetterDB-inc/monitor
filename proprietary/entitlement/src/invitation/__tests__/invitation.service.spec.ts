import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { InvitationService } from '../invitation.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Tenant scoping on id-addressed invitation operations (GHSA-2rwf-9ffp-8pf2):
 * revoke and accept used to act on the bare primary key, so any holder of
 * the shared admin bearer (every tenant pod) could mutate another tenant's
 * invitations by id. A foreign id must 404 exactly like a missing one.
 */
describe('InvitationService tenant scoping', () => {
  let service: InvitationService;
  let prisma: { invitation: { findUnique: Mock; update: Mock } };

  const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const tenantAInvite = {
    id: 'inv-a1',
    email: 'new@tenant-a.test',
    tenantId: 'tenant-a',
    status: 'pending',
    expiresAt: futureDate,
  };

  beforeEach(async () => {
    prisma = {
      invitation: {
        findUnique: vi.fn().mockResolvedValue(tenantAInvite),
        update: vi.fn().mockImplementation(async ({ data }) => ({ ...tenantAInvite, ...data })),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [InvitationService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(InvitationService);
  });

  describe('revoke', () => {
    it('revokes within the same tenant', async () => {
      const result = await service.revoke('inv-a1', 'tenant-a');
      expect(result.status).toBe('revoked');
      expect(prisma.invitation.update).toHaveBeenCalledWith({
        where: { id: 'inv-a1' },
        data: { status: 'revoked' },
      });
    });

    it('404s and does NOT mutate on a cross-tenant id', async () => {
      await expect(service.revoke('inv-a1', 'tenant-b')).rejects.toThrow(NotFoundException);
      expect(prisma.invitation.update).not.toHaveBeenCalled();
    });

    it('still revokes unscoped when no tenantId is given', async () => {
      const result = await service.revoke('inv-a1');
      expect(result.status).toBe('revoked');
    });

    it('404s on a present-but-empty tenantId (fails closed, not open)', async () => {
      // `?tenantId=` reaches the service as '' — a mismatch, not "unscoped".
      // Only a genuinely absent (undefined) tenantId grants unscoped access.
      await expect(service.revoke('inv-a1', '')).rejects.toThrow(NotFoundException);
      expect(prisma.invitation.update).not.toHaveBeenCalled();
    });
  });

  describe('accept', () => {
    it('accepts within the same tenant', async () => {
      const result = await service.accept('inv-a1', 'user-1', 'tenant-a');
      expect(result.status).toBe('accepted');
    });

    it('404s and does NOT mutate on a cross-tenant id', async () => {
      await expect(service.accept('inv-a1', 'user-1', 'tenant-b')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.invitation.update).not.toHaveBeenCalled();
    });

    it('a missing id and a foreign id produce the same error', async () => {
      const foreign = await service.accept('inv-a1', 'user-1', 'tenant-b').catch((e) => e);
      prisma.invitation.findUnique.mockResolvedValue(null);
      const missing = await service.accept('gone', 'user-1', 'tenant-b').catch((e) => e);
      expect(foreign).toBeInstanceOf(NotFoundException);
      expect(missing).toBeInstanceOf(NotFoundException);
      expect((foreign as Error).message).toBe((missing as Error).message);
    });
  });
});
