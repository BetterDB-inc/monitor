import { Module } from '@nestjs/common';
import { ExternalMetricsStore } from './external-metrics-store';

@Module({
  providers: [ExternalMetricsStore],
  exports: [ExternalMetricsStore],
})
export class ExternalMetricsStoreModule {}
