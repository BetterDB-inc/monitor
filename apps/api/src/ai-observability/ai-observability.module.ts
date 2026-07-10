import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { StorageModule } from '../storage/storage.module';
import { DiscoveryReaderService } from './discovery-reader.service';
import { AiObservabilityService } from './ai-observability.service';
import { AiObservabilityController } from './ai-observability.controller';

@Module({
  imports: [ConnectionsModule, StorageModule],
  controllers: [AiObservabilityController],
  providers: [DiscoveryReaderService, AiObservabilityService],
  exports: [DiscoveryReaderService, AiObservabilityService],
})
export class AiObservabilityModule {}
