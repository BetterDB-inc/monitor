import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { AuditModule } from './audit/audit.module';
import { ClientAnalyticsModule } from './client-analytics/client-analytics.module';
import { PrometheusModule } from './prometheus/prometheus.module';
import { SettingsModule } from './settings/settings.module';
import { WebhooksModule } from './webhooks/webhooks.module';

let AiModule: any = null;
let LicenseModule: any = null;
let KeyAnalyticsModule: any = null;
let AnomalyModule: any = null;
let WebhookProModule: any = null;

try {
  const module = require('@proprietary/ai/ai.module');
  AiModule = module.AiModule;
  console.log('[AI] Proprietary module loaded');
} catch {
  // Proprietary module not available
}

try {
  const licenseModule = require('@proprietary/license/license.module');
  LicenseModule = licenseModule.LicenseModule;
  console.log('[License] Proprietary module loaded');
} catch {
  // Proprietary module not available
}

try {
  const keyAnalyticsModule = require('@proprietary/key-analytics/key-analytics.module');
  KeyAnalyticsModule = keyAnalyticsModule.KeyAnalyticsModule;
  console.log('[KeyAnalytics] Proprietary module loaded');
} catch {
  // Proprietary module not available
}

try {
  const anomalyModule = require('@proprietary/anomaly-detection/anomaly.module');
  AnomalyModule = anomalyModule.AnomalyModule;
  console.log('[AnomalyDetection] Proprietary module loaded');
} catch {
  // Proprietary module not available
}

try {
  const webhookProModule = require('@proprietary/webhook-pro');
  WebhookProModule = webhookProModule.WebhookProModule;
  console.log('[WebhookPro] Proprietary module loaded');
} catch {
  // Proprietary module not available
}

const baseImports = [
  ConfigModule,
  ThrottlerModule.forRoot([{
    ttl: 60000, // 60 seconds
    limit: 10000, // Very high default - endpoint-specific limits provide actual rate limiting
  }]),
  DatabaseModule,
  HealthModule,
  MetricsModule,
  AuditModule,
  ClientAnalyticsModule,
  PrometheusModule,
  SettingsModule,
  WebhooksModule,
];

const proprietaryImports = [
  LicenseModule,
  KeyAnalyticsModule,
  AnomalyModule,
  WebhookProModule,
  AiModule,
].filter(Boolean);

@Module({
  imports: [...baseImports, ...proprietaryImports],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
