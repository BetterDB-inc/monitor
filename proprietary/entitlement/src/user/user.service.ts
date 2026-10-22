import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createUser(data: CreateUserDto) {
    const user = await this.prisma.user.create({
      data: {
        email: data.email.toLowerCase(),
        name: data.name,
        avatarUrl: data.avatarUrl,
        provider: data.provider,
        providerId: data.providerId,
        tenantId: data.tenantId,
        role: data.role ?? 'member',
      },
      include: { tenant: true },
    });

    this.logger.log(`Created user: ${user.id} (${user.email}) for tenant ${user.tenantId}`);
    return user;
  }

  async getUserByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { tenant: true },
    });
  }

  async getUsersByTenant(tenantId: string) {
    return this.prisma.user.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getUser(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      include: { tenant: true },
    });
  }

  /**
   * Fetch a user scoped to a tenant: 404 if the id does not exist OR belongs
   * to a different tenant, so a foreign id is indistinguishable from a
   * missing one. Every id-addressed read/mutation must go through this —
   * operating on the bare primary key let any holder of the shared admin
   * token (every tenant pod) delete another tenant's users by id
   * (GHSA-2rwf-9ffp-8pf2). Mirrors ValkeyInstanceService.getInstanceForTenant.
   *
   * The scoping check is on `tenantId !== undefined`, not truthiness: a
   * present-but-empty tenantId (e.g. `?tenantId=`) is a mismatch and 404s,
   * so only a genuinely absent param grants unscoped admin access. A
   * truthiness check would let an empty tenantId skip scoping and fail open.
   */
  async getUserForTenant(id: string, tenantId?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { tenant: true },
    });
    if (!user || (tenantId !== undefined && user.tenantId !== tenantId)) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return user;
  }

  async deleteUser(id: string, tenantId?: string) {
    const user = await this.getUserForTenant(id, tenantId);

    await this.prisma.user.delete({ where: { id } });
    this.logger.log(`Deleted user: ${id} (${user.email}) from tenant ${user.tenantId}`);
    return { deleted: true };
  }
}
