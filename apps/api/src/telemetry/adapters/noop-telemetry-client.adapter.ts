import { TelemetryPort, TelemetryEvent } from '../../common/interfaces/telemetry-port.interface';

export class NoopTelemetryClientAdapter implements TelemetryPort {
  capture(_event: TelemetryEvent): void {}
  identify(_distinctId: string, _properties: Record<string, unknown>): void {}
  async shutdown(): Promise<void> {}
}
