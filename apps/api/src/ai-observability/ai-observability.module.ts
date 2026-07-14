import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { StorageModule } from '../storage/storage.module';
import { DiscoveryReaderService } from './discovery-reader.service';
import { AiObservabilityService } from './ai-observability.service';
import { AiObservabilityController } from './ai-observability.controller';
import { OtelIngestService } from './otel-ingest.service';
import { OtelIngestController } from './otel-ingest.controller';
import { TraceCorrelationService } from './trace-correlation.service';

@Module({
  imports: [ConnectionsModule, StorageModule],
  controllers: [AiObservabilityController, OtelIngestController],
  providers: [
    DiscoveryReaderService,
    AiObservabilityService,
    OtelIngestService,
    TraceCorrelationService,
  ],
  exports: [DiscoveryReaderService, AiObservabilityService],
})
export class AiObservabilityModule {}
