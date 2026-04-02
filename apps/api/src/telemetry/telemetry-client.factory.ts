import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelemetryPort } from '../common/interfaces/telemetry-port.interface';
import { NoopTelemetryClientAdapter } from './adapters/noop-telemetry-client.adapter';
import { HttpTelemetryClientAdapter } from './adapters/http-telemetry-client.adapter';
import { PosthogTelemetryClientAdapter } from './adapters/posthog-telemetry-client.adapter';

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
        const host = this.configService.get<string>('POSTHOG_HOST');
        return new PosthogTelemetryClientAdapter(apiKey, host);
      }

      case 'http': {
        const entitlementUrl =
          this.configService.get<string>('ENTITLEMENT_URL') ||
          'https://betterdb.com/api/v1/entitlements';
        const url = new URL(entitlementUrl);
        url.pathname = url.pathname.replace(/\/entitlements$/, '/telemetry');
        return new HttpTelemetryClientAdapter(url.toString());
      }

      default:
        console.warn(`Unknown TELEMETRY_PROVIDER "${provider}". Falling back to noop telemetry.`);
        return new NoopTelemetryClientAdapter();
    }
  }
}
