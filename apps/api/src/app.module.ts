import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { AuditModule } from './audit/audit.module';

@Module({
  imports: [ConfigModule, DatabaseModule, HealthModule, MetricsModule, AuditModule],
})
export class AppModule {}
