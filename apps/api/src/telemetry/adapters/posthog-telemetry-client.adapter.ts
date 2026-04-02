import { PostHog } from 'posthog-node';
import { TelemetryPort, TelemetryEvent } from '../../common/interfaces/telemetry-port.interface';

export class PosthogTelemetryClientAdapter implements TelemetryPort {
  private readonly client: PostHog;

  constructor(apiKey: string, host?: string) {
    this.client = new PostHog(apiKey, {
      ...(host ? { host } : {}),
    });
  }

  capture(event: TelemetryEvent): void {
    this.client.capture({
      distinctId: event.distinctId,
      event: event.event,
      properties: event.properties,
    });
  }

  identify(distinctId: string, properties: Record<string, unknown>): void {
    this.client.identify({
      distinctId,
      properties,
    });
  }

  async shutdown(): Promise<void> {
    await this.client.shutdown();
  }
}
