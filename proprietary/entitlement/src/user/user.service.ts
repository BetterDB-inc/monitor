import { Injectable, Logger } from '@nestjs/common';
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
}
