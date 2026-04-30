import { Module, forwardRef } from '@nestjs/common';
import { INFERENCE_LATENCY_PRO_SERVICE } from '@betterdb/shared';
import { ConnectionsModule } from '@app/connections/connections.module';
import { InferenceLatencyModule } from '@app/inference-latency/inference-latency.module';
import { PrometheusModule } from '@app/prometheus/prometheus.module';
import { SettingsModule } from '@app/settings/settings.module';
import { InferenceLatencyProController } from './inference-latency-pro.controller';
import { InferenceLatencyProService } from './inference-latency-pro.service';

@Module({
  imports: [
    forwardRef(() => InferenceLatencyModule),
    ConnectionsModule,
    PrometheusModule,
    SettingsModule,
  ],
  controllers: [InferenceLatencyProController],
  providers: [
    InferenceLatencyProService,
    {
      provide: INFERENCE_LATENCY_PRO_SERVICE,
      useExisting: InferenceLatencyProService,
    },
  ],
  exports: [InferenceLatencyProService, INFERENCE_LATENCY_PRO_SERVICE],
})
export class InferenceLatencyProModule {}
