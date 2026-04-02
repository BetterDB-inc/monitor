import type { TelemetryClient } from '../telemetry-client.interface';

export class NoopTelemetryClient implements TelemetryClient {
  capture(_event: string, _properties?: Record<string, unknown>): void {}
  identify(_distinctId: string, _properties: Record<string, unknown>): void {}
  shutdown(): void {}
}
