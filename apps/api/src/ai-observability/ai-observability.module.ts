import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { StorageModule } from '../storage/storage.module';
import { DiscoveryReaderService } from './discovery-reader.service';
import { AiObservabilityService } from './ai-observability.service';

@Module({
  imports: [ConnectionsModule, StorageModule],
  providers: [DiscoveryReaderService, AiObservabilityService],
  exports: [DiscoveryReaderService, AiObservabilityService],
})
export class AiObservabilityModule {}
