import { Module } from '@nestjs/common';
import { ConnectionsModule } from '@app/connections/connections.module';
import { StorageModule } from '@app/storage/storage.module';
import { LicenseModule } from '@proprietary/licenses';
import { KvCacheController } from './kv-cache.controller';
import { KvCacheEngineRegistry } from './kv-cache-engine-registry';
import { KvCacheEnginesService } from './kv-cache-engines.service';
import { KvCacheFootprintService } from './kv-cache-footprint.service';
import { KvCacheStatusService } from './kv-cache-status.service';

@Module({
  imports: [StorageModule, ConnectionsModule, LicenseModule],
  controllers: [KvCacheController],
  providers: [KvCacheFootprintService, KvCacheStatusService, KvCacheEngineRegistry, KvCacheEnginesService],
})
export class KvCacheModule {}
