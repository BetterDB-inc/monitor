import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    // Check database connection
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      return {
        status: 'unhealthy',
        database: 'disconnected',
        error: error.message,
      };
    }

    return {
      status: 'healthy',
      database: 'connected',
      timestamp: new Date().toISOString(),
    };
  }
}
