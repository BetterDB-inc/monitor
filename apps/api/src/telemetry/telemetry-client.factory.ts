import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelemetryPort } from '../common/interfaces/telemetry-port.interface';
import { NoopTelemetryAdapter } from './adapters/noop-telemetry.adapter';

@Injectable()
export class TelemetryClientFactory {
  constructor(private configService: ConfigService) {}

  createTelemetryClient(): TelemetryPort {
    const telemetryEnabled = this.configService.get<string>('BETTERDB_TELEMETRY');
    if (telemetryEnabled === 'false') {
      return new NoopTelemetryAdapter();
    }

    const provider = this.configService.get<string>('TELEMETRY_PROVIDER', 'posthog');

    switch (provider) {
      case 'noop':
        return new NoopTelemetryAdapter();

      case 'posthog': {
        const apiKey = this.configService.get<string>('POSTHOG_API_KEY');
        if (!apiKey) {
          console.warn(
            'TELEMETRY_PROVIDER is "posthog" but POSTHOG_API_KEY is not set. Falling back to noop telemetry.',
          );
          return new NoopTelemetryAdapter();
        }
        // PosthogTelemetryAdapter will be added in issue #73
        return new NoopTelemetryAdapter();
      }

      case 'http':
        // HttpTelemetryAdapter will be added in issue #72
        return new NoopTelemetryAdapter();

      default:
        console.warn(`Unknown TELEMETRY_PROVIDER "${provider}". Falling back to noop telemetry.`);
        return new NoopTelemetryAdapter();
    }
  }
}
