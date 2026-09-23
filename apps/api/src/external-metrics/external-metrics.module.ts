import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ExternalConnectionUnsupportedFilter } from './external-connection-unsupported.filter';
import { ExternalMetricsStoreModule } from './external-metrics-store.module';
import { OtelMetricsIngestController } from './otel-metrics-ingest.controller';
import { OtelMetricsIngestService } from './otel-metrics-ingest.service';

@Module({
  imports: [ExternalMetricsStoreModule],
  controllers: [OtelMetricsIngestController],
  providers: [OtelMetricsIngestService, { provide: APP_FILTER, useClass: ExternalConnectionUnsupportedFilter }],
})
export class ExternalMetricsModule {}
