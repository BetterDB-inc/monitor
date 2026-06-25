import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
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

    const existingCount = await this.prisma.valkeyInstance.count({
      where: { tenantId: dto.tenantId },
    });
    if (existingCount >= MAX_INSTANCES_PER_TENANT) {
      throw new ConflictException(
        `This workspace already has the maximum of ${MAX_INSTANCES_PER_TENANT} Valkey instance(s)`,
      );
    }

    const name = dto.name.toLowerCase();

    // The name doubles as the public SNI host (<name>.valkey.betterdb.com),
    // which is a single shared wildcard zone, so it must be globally unique.
    const nameTaken = await this.prisma.valkeyInstance.findFirst({ where: { name } });
    if (nameTaken) {
      throw new ConflictException(`The name '${name}' is already taken`);
    }

    const instance = await this.prisma.valkeyInstance.create({
      data: {
        tenantId: dto.tenantId,
        name,
        username: 'app',
        secretName: `valkey-${name}-auth`,
        maxmemory: dto.maxmemory ?? null,
        status: 'pending',
      },
    });

    this.logger.log(`Created valkey instance ${instance.id} (${name}) for tenant ${dto.tenantId}`);
    return instance;
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

  // Marks the instance for deletion; the controller fires the async
  // deprovision (which removes k8s objects and deletes the row on success).
  async markForDeletion(id: string) {
    await this.getInstance(id);
    const instance = await this.prisma.valkeyInstance.update({
      where: { id },
      data: { status: 'deleting' },
    });
    this.logger.log(`Marked valkey instance ${id} for deletion`);
    return instance;
  }
}
