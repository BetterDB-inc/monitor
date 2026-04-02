export interface TelemetryEvent {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}

export interface TelemetryPort {
  capture(event: TelemetryEvent): void;
  identify(distinctId: string, properties: Record<string, unknown>): void;
  shutdown(): Promise<void>;
}
