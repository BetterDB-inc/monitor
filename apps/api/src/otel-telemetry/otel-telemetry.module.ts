import { Module } from '@nestjs/common';
import { PrometheusModule } from '../prometheus/prometheus.module';
import { OtelMetricsExporterService } from './otel-metrics-exporter.service';

@Module({
  imports: [PrometheusModule],
  providers: [OtelMetricsExporterService],
  exports: [OtelMetricsExporterService],
})
export class OtelTelemetryModule {}
