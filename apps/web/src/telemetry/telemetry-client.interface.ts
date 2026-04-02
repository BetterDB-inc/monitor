export interface TelemetryClient {
  capture(event: string, properties?: Record<string, unknown>): void;
  identify(distinctId: string, properties: Record<string, unknown>): void;
  shutdown(): void;
}
