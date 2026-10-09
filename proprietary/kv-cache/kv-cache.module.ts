import { Global, Module } from '@nestjs/common';
import { KV_CACHE_OTLP_SINK } from '@app/external-metrics/kv-cache-otlp-sink';
import { ConnectionsModule } from '@app/connections/connections.module';
import { PrometheusModule } from '@app/prometheus/prometheus.module';
import { StorageModule } from '@app/storage/storage.module';
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

@Global()
@Module({
  imports: [StorageModule, ConnectionsModule, LicenseModule, PrometheusModule],
  controllers: [KvCacheController],
  providers: [KvCacheFootprintService, KvCacheAlertsService, KvCacheStatusService, KvCacheEngineRegistry, KvCacheSamplesService, KvCacheEnginesService, KvCacheScrapeService, KvCacheOtlpSinkService, { provide: KV_CACHE_OTLP_SINK, useExisting: KvCacheOtlpSinkService }],
  exports: [KV_CACHE_OTLP_SINK],
})
export class KvCacheModule {}
