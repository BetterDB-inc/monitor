import { Global, Logger, Module } from '@nestjs/common';
import { KV_CACHE_OTLP_SINK } from '@app/external-metrics/kv-cache-otlp-sink';
import { ConnectionsModule } from '@app/connections/connections.module';
import { PrometheusModule } from '@app/prometheus/prometheus.module';
import { StorageModule } from '@app/storage/storage.module';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { createAgentTokenProviders } from '@app/common/guards/agent-token-providers';
import { LicenseModule } from '@proprietary/licenses';
import { KvCacheAlertsService } from './kv-cache-alerts.service';
import { KvCacheController } from './kv-cache.controller';
import { KvCacheEngineRegistry } from './kv-cache-engine-registry';
import { KvCacheEnginesService } from './kv-cache-engines.service';
import { KvCacheFootprintService } from './kv-cache-footprint.service';
import { KvCacheOtlpSinkService } from './kv-cache-otlp-sink.service';
import { KvCacheScrapeService } from './kv-cache-scrape.service';
import { KvCacheSamplesService } from './kv-cache-samples.service';
import { KvCacheStatusService } from './kv-cache-status.service';
import { McpKvCacheController } from './mcp-kv-cache.controller';

const logger = new Logger('KvCacheModule');
const tokenProviders = createAgentTokenProviders(logger, () => {
  return require('../agent/agent-tokens.service');
});

@Global()
@Module({
  imports: [StorageModule, ConnectionsModule, LicenseModule, PrometheusModule],
  controllers: [KvCacheController, McpKvCacheController],
  providers: [KvCacheFootprintService, KvCacheAlertsService, KvCacheStatusService, KvCacheEngineRegistry, KvCacheSamplesService, KvCacheEnginesService, KvCacheScrapeService, KvCacheOtlpSinkService, AgentTokenGuard, ...tokenProviders, { provide: KV_CACHE_OTLP_SINK, useExisting: KvCacheOtlpSinkService }],
  exports: [KV_CACHE_OTLP_SINK],
})
export class KvCacheModule {}
