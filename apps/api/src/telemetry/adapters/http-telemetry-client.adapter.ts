import { TelemetryPort, TelemetryEvent } from '../../common/interfaces/telemetry-port.interface';

export class HttpTelemetryClientAdapter implements TelemetryPort {
  constructor(private readonly telemetryUrl: string) {}

  capture(event: TelemetryEvent): void {
    fetch(this.telemetryUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {
      // fire-and-forget
    });
  }

  identify(_distinctId: string, _properties: Record<string, unknown>): void {}
  async shutdown(): Promise<void> {}
}
