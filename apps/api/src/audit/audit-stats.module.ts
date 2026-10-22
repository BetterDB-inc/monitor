import { Module } from '@nestjs/common';
import { AuditStatsCacheService } from './audit-stats-cache.service';

/** No imports on purpose: both AuditModule and PrometheusModule import this without a cycle. */
@Module({
  providers: [AuditStatsCacheService],
  exports: [AuditStatsCacheService],
})
export class AuditStatsModule {}
