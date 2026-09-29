import { Module } from '@nestjs/common';
import { isTrueFlag } from '../config/env-normalize';
import { DiscoveredInstancesStore } from './discovered-instances.store';
import { ExternalMetricsStore } from './external-metrics-store';

@Module({
  providers: [
    ExternalMetricsStore,
    {
      provide: DiscoveredInstancesStore,
      useFactory: () => new DiscoveredInstancesStore(isTrueFlag(process.env.OTLP_DISCOVER_INSTANCES ?? 'true')),
    },
  ],
  exports: [ExternalMetricsStore, DiscoveredInstancesStore],
})
export class ExternalMetricsStoreModule {}
