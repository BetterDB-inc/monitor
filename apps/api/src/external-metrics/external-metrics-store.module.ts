import { Module } from '@nestjs/common';
import { isNegativeEnvValue } from '../common/utils/env-bool';
import { DiscoveredInstancesStore } from './discovered-instances.store';
import { ExternalMetricsStore } from './external-metrics-store';

@Module({
  providers: [
    ExternalMetricsStore,
    {
      provide: DiscoveredInstancesStore,
      useFactory: () => new DiscoveredInstancesStore(!isNegativeEnvValue(process.env.OTLP_DISCOVER_INSTANCES)),
    },
  ],
  exports: [ExternalMetricsStore, DiscoveredInstancesStore],
})
export class ExternalMetricsStoreModule {}
