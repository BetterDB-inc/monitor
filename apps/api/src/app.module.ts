import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ConfigModule } from './config/config.module';
import { ConnectionsModule } from './connections/connections.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { AuditModule } from './audit/audit.module';
import { ClientAnalyticsModule } from './client-analytics/client-analytics.module';
import { SlowLogAnalyticsModule } from './slowlog-analytics/slowlog-analytics.module';
import { CommandLogAnalyticsModule } from './commandlog-analytics/commandlog-analytics.module';
import { LatencyAnalyticsModule } from './latency-analytics/latency-analytics.module';
import { MemoryAnalyticsModule } from './memory-analytics/memory-analytics.module';
import { PrometheusModule } from './prometheus/prometheus.module';
import { SettingsModule } from './settings/settings.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { VectorSearchModule } from './vector-search/vector-search.module';
import { MigrationModule } from './migration/migration.module';
import { CloudAuthModule } from './auth/cloud-auth.module';
import { McpModule } from './mcp/mcp.module';
import { MetricForecastingModule } from './metric-forecasting/metric-forecasting.module';
import { InferenceLatencyModule } from './inference-latency/inference-latency.module';
import { CliModule } from './cli/cli.module';
import { PosthogProxyModule } from './posthog-proxy/posthog-proxy.module';

let AiModule: any = null;
let LicenseModule: any = null;
let KeyAnalyticsModule: any = null;
let AnomalyModule: any = null;
let WebhookProModule: any = null;
let InferenceLatencyProModule: any = null;
let AgentModule: any = null;
let DataRetentionModule: any = null;

try {
  // Use relative path for runtime resolution (tsconfig paths only work at compile time)
  const module = require('../../../proprietary/ai/ai.module');
  AiModule = module.AiModule;
  console.log('[AI] Proprietary module loaded');
} catch {
  // Proprietary module not available
}

try {
  const licenseModule = require('../../../proprietary/licenses/license.module');
  LicenseModule = licenseModule.LicenseModule;
  console.log('[License] Proprietary module loaded');
} catch {
  // Proprietary module not available
}

try {
  const keyAnalyticsModule = require('../../../proprietary/key-analytics/key-analytics.module');
  KeyAnalyticsModule = keyAnalyticsModule.KeyAnalyticsModule;
  console.log('[KeyAnalytics] Proprietary module loaded');
} catch {
  // Proprietary module not available
}

try {
  const anomalyModule = require('../../../proprietary/anomaly-detection/anomaly.module');
  AnomalyModule = anomalyModule.AnomalyModule;
  console.log('[AnomalyDetection] Proprietary module loaded');
} catch {
  // Proprietary module not available
}

try {
  const webhookProModule = require('../../../proprietary/webhook-pro');
  WebhookProModule = webhookProModule.WebhookProModule;
  console.log('[WebhookPro] Proprietary module loaded');
} catch {
  // Proprietary module not available
}

try {
  const inferenceLatencyProModule = require('../../../proprietary/inference-latency-pro/inference-latency-pro.module');
  InferenceLatencyProModule = inferenceLatencyProModule.InferenceLatencyProModule;
  console.log('[InferenceLatencyPro] Proprietary module loaded');
} catch {
  // Proprietary module not available
}

if (process.env.CLOUD_MODE) {
  try {
    const agentModule = require('../../../proprietary/agent/agent.module');
    AgentModule = agentModule.AgentModule;
    console.log('[Agent] Proprietary module loaded');
  } catch {
    // Proprietary module not available
  }

  try {
    const dataRetentionModule = require('../../../proprietary/data-retention/data-retention.module');
    DataRetentionModule = dataRetentionModule.DataRetentionModule;
    console.log('[DataRetention] Proprietary module loaded');
  } catch {
    // Proprietary module not available
  }
}

// Cloud auth module - uses proprietary implementation in cloud mode
let CloudAuthModuleToUse: any = CloudAuthModule;
if (process.env.CLOUD_MODE) {
  try {
    const proprietaryCloudAuth = require('../../../proprietary/cloud-auth/cloud-auth.module');
    CloudAuthModuleToUse = proprietaryCloudAuth.ProprietaryCloudAuthModule;
    console.log('[CloudAuth] Proprietary module loaded');
  } catch {
    // Proprietary module not available, use OSS no-op
  }
}

const baseImports = [
  ConfigModule,
  ThrottlerModule.forRoot([{
    ttl: 60000, // 60 seconds
    limit: 10000, // Very high default - endpoint-specific limits provide actual rate limiting
  }]),
  CloudAuthModuleToUse, // Cloud auth (no-op for self-hosted, proprietary for cloud)
  ConnectionsModule, // Must come early - provides ConnectionRegistry globally
  HealthModule,
  MetricsModule,
  AuditModule,
  ClientAnalyticsModule,
  SlowLogAnalyticsModule,
  CommandLogAnalyticsModule,
  LatencyAnalyticsModule,
  MemoryAnalyticsModule,
  PrometheusModule,
  SettingsModule,
  WebhooksModule,
  McpModule,
  VectorSearchModule,
  MigrationModule,
  MetricForecastingModule,
  InferenceLatencyModule,
  CliModule,
  PosthogProxyModule,
];

const proprietaryImports = [
  LicenseModule,
  KeyAnalyticsModule,
  AnomalyModule,
  WebhookProModule,
  InferenceLatencyProModule,
  AiModule,
  AgentModule,
  DataRetentionModule,
].filter(Boolean);

@Module({
  imports: [...baseImports, ...proprietaryImports, TelemetryModule],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule { }
