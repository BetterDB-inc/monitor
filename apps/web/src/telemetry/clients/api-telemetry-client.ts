import type { TelemetryClient } from '../telemetry-client.interface';
import { fetchApi } from '../../api/client';

export class ApiTelemetryClient implements TelemetryClient {
  capture(event: string, properties?: Record<string, unknown>): void {
    fetchApi('/telemetry/event', {
      method: 'POST',
      body: JSON.stringify({
        eventType: event,
        payload: properties ?? {},
      }),
    }).catch(() => {});
  }

  identify(_distinctId: string, _properties: Record<string, unknown>): void {}
  shutdown(): void {}
}
