import { TelemetryPort, TelemetryEvent } from '../../common/interfaces/telemetry-port.interface';

// TODO(#72): Replace stubs with real HTTP fetch implementation
export class HttpTelemetryClientAdapter implements TelemetryPort {
  constructor(private readonly telemetryUrl: string) {}

  capture(_event: TelemetryEvent): void {}
  identify(_distinctId: string, _properties: Record<string, unknown>): void {}
  async shutdown(): Promise<void> {}
}
