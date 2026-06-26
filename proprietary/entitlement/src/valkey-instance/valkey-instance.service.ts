import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateValkeyInstanceDto } from './dto/create-valkey-instance.dto';

// v1 caps each workspace at a single Valkey instance. The schema allows many
// (ValkeyInstance has a tenant relation, no unique on tenantId) so this limit
// can be lifted later by tier without a migration.
const MAX_INSTANCES_PER_TENANT = 1;

@Injectable()
export class ValkeyInstanceService {
  private readonly logger = new Logger(ValkeyInstanceService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createInstance(dto: CreateValkeyInstanceDto) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: dto.tenantId } });
    if (!tenant) {
      throw new NotFoundException(`Tenant ${dto.tenantId} not found`);
    }

    const name = dto.name.toLowerCase();

    try {
      // Serializable so two concurrent creates can't both pass the cap check.
      // The name is unique per tenant (composite DB constraint, handled by the
      // P2002 catch below); the public SNI host is a separate opaque hash.
      const instance = await this.prisma.$transaction(
        async (tx) => {
          const existingCount = await tx.valkeyInstance.count({
            where: { tenantId: dto.tenantId },
          });
          if (existingCount >= MAX_INSTANCES_PER_TENANT) {
            throw new ConflictException(
              `This workspace already has the maximum of ${MAX_INSTANCES_PER_TENANT} Valkey instance(s)`,
            );
          }

          return tx.valkeyInstance.create({
            data: {
              tenantId: dto.tenantId,
              name,
              username: 'app',
              secretName: `valkey-${name}-auth`,
              maxmemory: dto.maxmemory ?? null,
              status: 'pending',
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );

      this.logger.log(`Created valkey instance ${instance.id} (${name}) for tenant ${dto.tenantId}`);
      return instance;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`The name '${name}' is already taken`);
      }
      throw error;
    }
  }

  async listInstances(tenantId: string) {
    return this.prisma.valkeyInstance.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getInstance(id: string) {
    const instance = await this.prisma.valkeyInstance.findUnique({ where: { id } });
    if (!instance) {
      throw new NotFoundException(`Valkey instance ${id} not found`);
    }
    return instance;
  }

  // Tenant-scoped lookup: callers acting on behalf of a workspace pass their
  // tenantId so an instance from another tenant is treated as not found
  // (prevents cross-tenant access to credentials / teardown).
  async getInstanceForTenant(id: string, tenantId?: string) {
    const instance = await this.getInstance(id);
    if (tenantId && instance.tenantId !== tenantId) {
      throw new NotFoundException(`Valkey instance ${id} not found`);
    }
    return instance;
  }

  // Marks the instance for deletion; the controller fires the async
  // deprovision (which removes k8s objects and deletes the row on success).
  async markForDeletion(id: string, tenantId?: string) {
    await this.getInstanceForTenant(id, tenantId);
    const instance = await this.prisma.valkeyInstance.update({
      where: { id },
      data: { status: 'deleting' },
    });
    this.logger.log(`Marked valkey instance ${id} for deletion`);
    return instance;
  }
}
