import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ConnectionsModule } from '../connections/connections.module';
import { PrometheusModule } from '../prometheus/prometheus.module';
import { VectorSearchController } from './vector-search.controller';
import { VectorSearchService } from './vector-search.service';

@Module({
  imports: [StorageModule, ConnectionsModule, PrometheusModule],
  controllers: [VectorSearchController],
  providers: [VectorSearchService],
  exports: [VectorSearchService],
})
export class VectorSearchModule {}
