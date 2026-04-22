import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { PrometheusModule } from '../prometheus/prometheus.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { InferenceLatencyController } from './inference-latency.controller';
import { InferenceLatencyService } from './inference-latency.service';

@Module({
  imports: [StorageModule, ConnectionsModule, PrometheusModule, SettingsModule],
  controllers: [InferenceLatencyController],
  providers: [InferenceLatencyService],
  exports: [InferenceLatencyService],
})
export class InferenceLatencyModule {}
