import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelemetryPort } from '../common/interfaces/telemetry-port.interface';
import { NoopTelemetryClientAdapter } from './adapters/noop-telemetry-client.adapter';

@Injectable()
export class TelemetryClientFactory {
  constructor(private configService: ConfigService) {}

  createTelemetryClient(): TelemetryPort {
    const telemetryEnabled = this.configService.get<boolean>('BETTERDB_TELEMETRY');
    if (telemetryEnabled === false) {
      return new NoopTelemetryClientAdapter();
    }

    const provider = this.configService.get<string>('TELEMETRY_PROVIDER', 'posthog');

    switch (provider) {
      case 'noop':
        return new NoopTelemetryClientAdapter();

      case 'posthog': {
        const apiKey = this.configService.get<string>('POSTHOG_API_KEY');
        if (!apiKey) {
          console.warn(
            'TELEMETRY_PROVIDER is "posthog" but POSTHOG_API_KEY is not set. Falling back to noop telemetry.',
          );
          return new NoopTelemetryClientAdapter();
        }
        // PosthogTelemetryAdapter will be added in issue #73
        return new NoopTelemetryClientAdapter();
      }

      case 'http':
        // HttpTelemetryAdapter will be added in issue #72
        return new NoopTelemetryClientAdapter();

      default:
        console.warn(`Unknown TELEMETRY_PROVIDER "${provider}". Falling back to noop telemetry.`);
        return new NoopTelemetryClientAdapter();
    }
  }
}
