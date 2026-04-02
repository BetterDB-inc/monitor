import { TelemetryPort, TelemetryEvent } from '../../common/interfaces/telemetry-port.interface';

// TODO(#73): Replace stubs with real posthog-node implementation
export class PosthogTelemetryClientAdapter implements TelemetryPort {
  constructor(
    private readonly apiKey: string,
    private readonly host?: string,
  ) {}

  capture(_event: TelemetryEvent): void {}
  identify(_distinctId: string, _properties: Record<string, unknown>): void {}
  async shutdown(): Promise<void> {}
}
