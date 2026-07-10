import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { DiscoveryReaderService } from './discovery-reader.service';

@Module({
  imports: [ConnectionsModule],
  providers: [DiscoveryReaderService],
  exports: [DiscoveryReaderService],
})
export class AiObservabilityModule {}
