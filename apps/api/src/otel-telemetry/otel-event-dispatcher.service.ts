import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SeverityNumber, type Logger as OtelLogger } from '@opentelemetry/api-logs';
import { LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { buildEventAttributes } from './event-attributes';

/**
 * Emits discrete monitoring events (e.g. anomaly.detected, cluster.failover) as
 * OTel log records over OTLP, mirroring the events already dispatched to
 * webhooks. Callers pass the same payload built for the webhook at each site;
 * no detection logic lives here. No-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set
 * and OTEL_TELEMETRY_ENABLED. Provided globally so any service can inject it
 * @Optional() without a module import cycle.
 */
@Injectable()
export class OtelEventDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OtelEventDispatcherService.name);
  private provider?: LoggerProvider;
  private otelLogger?: OtelLogger;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const enabled = String(this.configService.get('OTEL_TELEMETRY_ENABLED', 'true')) !== 'false';
    const endpoint = this.configService.get<string>('OTEL_EXPORTER_OTLP_ENDPOINT');
    if (!enabled || !endpoint) {
      this.logger.log('OTel event dispatch disabled (set OTEL_EXPORTER_OTLP_ENDPOINT to enable)');
      return;
    }

    const exporter = new OTLPLogExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/logs` });
    this.provider = new LoggerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'betterdb-monitor' }),
      processors: [new SimpleLogRecordProcessor({ exporter })],
    });
    this.otelLogger = this.provider.getLogger('betterdb-events');
    this.logger.log(`OTel event dispatch active → ${endpoint}`);
  }

  dispatch(eventName: string, attributes: Record<string, unknown>, connectionId?: string): void {
    const otelLogger = this.otelLogger;
    if (!otelLogger) {
      return;
    }
    otelLogger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: eventName,
      attributes: buildEventAttributes(eventName, attributes, connectionId),
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.provider) {
      return;
    }
    await this.provider.shutdown().catch(() => {});
  }
}
