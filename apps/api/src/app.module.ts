import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { AuditModule } from './audit/audit.module';
import { ClientAnalyticsModule } from './client-analytics/client-analytics.module';
import { PrometheusModule } from './prometheus/prometheus.module';
import { AnomalyModule } from './anomaly/anomaly.module';

let AiModule: any = null;
try {
  const module = require('@proprietary/ai/ai.module');
  AiModule = module.AiModule;
  console.log('[AI] Proprietary module loaded');
} catch {
  // Proprietary module not available
}

const baseImports = [
  ConfigModule,
  DatabaseModule,
  HealthModule,
  MetricsModule,
  AuditModule,
  ClientAnalyticsModule,
  PrometheusModule,
  AnomalyModule,
];

@Module({
  imports: AiModule ? [...baseImports, AiModule] : baseImports,
})
export class AppModule {}
