import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInvitationDto } from './dto/create-invitation.dto';

@Injectable()
export class InvitationService {
  private readonly logger = new Logger(InvitationService.name);

  constructor(private readonly prisma: PrismaService) { }

  async create(data: CreateInvitationDto) {
    const email = data.email.toLowerCase();

    // Check user not already in tenant
    const existingUser = await this.prisma.user.findFirst({
      where: { email, tenantId: data.tenantId },
    });
    if (existingUser) {
      throw new ConflictException('User is already a member of this tenant');
    }

    // Check no duplicate pending invite
    const existingInvite = await this.prisma.invitation.findUnique({
      where: { email_tenantId: { email, tenantId: data.tenantId } },
    });
    if (existingInvite && existingInvite.status === 'pending') {
      throw new ConflictException('A pending invitation already exists for this email');
    }

    // If there's a non-pending invite (accepted/revoked), upsert it
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const invitation = await this.prisma.invitation.upsert({
      where: { email_tenantId: { email, tenantId: data.tenantId } },
      update: {
        role: data.role,
        invitedBy: data.invitedBy,
        status: 'pending',
        expiresAt,
        createdAt: new Date(),
      },
      create: {
        email,
        tenantId: data.tenantId,
        role: data.role,
        invitedBy: data.invitedBy,
        status: 'pending',
        expiresAt,
      },
    });

    this.logger.log(`Created invitation ${invitation.id} for ${email} to tenant ${data.tenantId}`);
    return invitation;
  }

  async listByTenant(tenantId: string) {
    return this.prisma.invitation.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async checkForEmail(email: string, tenantId?: string) {
    const where: any = {
      email: email.toLowerCase(),
      status: 'pending',
      expiresAt: { gt: new Date() },
    };
    if (tenantId) {
      where.tenantId = tenantId;
    }
    const invitation = await this.prisma.invitation.findFirst({ where });
    if (!invitation) {
      return { hasInvitation: false };
    }
    return {
      hasInvitation: true,
      invitation: {
        id: invitation.id,
        tenantId: invitation.tenantId,
        role: invitation.role,
      },
    };
  }

  /**
   * Fetch an invitation scoped to a tenant: 404 if the id does not exist OR
   * belongs to a different tenant, so a foreign id is indistinguishable from
   * a missing one. Every id-addressed mutation must go through this —
   * operating on the bare primary key let any holder of the shared admin
   * token (every tenant pod) revoke or accept another tenant's invitations
   * by id (GHSA-2rwf-9ffp-8pf2). Mirrors
   * ValkeyInstanceService.getInstanceForTenant.
   *
   * The scoping check is on `tenantId !== undefined`, not truthiness: a
   * present-but-empty tenantId (e.g. `?tenantId=`) is a mismatch and 404s,
   * so only a genuinely absent param grants unscoped admin access. A
   * truthiness check would let an empty tenantId skip scoping and fail open.
   */
  private async getInvitationForTenant(id: string, tenantId?: string) {
    const invitation = await this.prisma.invitation.findUnique({
      where: { id },
    });
    if (!invitation || (tenantId !== undefined && invitation.tenantId !== tenantId)) {
      throw new NotFoundException('Invitation not found');
    }
    return invitation;
  }

  async accept(invitationId: string, userId: string, tenantId?: string) {
    const invitation = await this.getInvitationForTenant(invitationId, tenantId);

    if (invitation.status !== 'pending') {
      throw new BadRequestException(`Invitation is ${invitation.status}`);
    }
    if (invitation.expiresAt < new Date()) {
      throw new BadRequestException('Invitation has expired');
    }

    const updated = await this.prisma.invitation.update({
      where: { id: invitationId },
      data: { status: 'accepted' },
    });

    this.logger.log(`Invitation ${invitationId} accepted by user ${userId}`);
    return updated;
  }

  async revoke(invitationId: string, tenantId?: string) {
    const invitation = await this.getInvitationForTenant(invitationId, tenantId);

    if (invitation.status !== 'pending') {
      throw new BadRequestException(`Cannot revoke invitation with status ${invitation.status}`);
    }

    const updated = await this.prisma.invitation.update({
      where: { id: invitationId },
      data: { status: 'revoked' },
    });

    this.logger.log(`Invitation ${invitationId} revoked`);
    return updated;
  }
}
