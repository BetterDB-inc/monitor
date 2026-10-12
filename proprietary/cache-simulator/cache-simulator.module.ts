import { Module } from '@nestjs/common';
import { StorageModule } from '@app/storage/storage.module';
import { ConnectionsModule } from '@app/connections/connections.module';
import { LicenseModule } from '@proprietary/licenses';
import { CacheSimulatorController } from './cache-simulator.controller';
import { CacheSimulatorService } from './cache-simulator.service';

@Module({
  imports: [StorageModule, ConnectionsModule, LicenseModule],
  controllers: [CacheSimulatorController],
  providers: [CacheSimulatorService],
})
export class CacheSimulatorModule {}
