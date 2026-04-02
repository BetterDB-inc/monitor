import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelemetryPort } from '../common/interfaces/telemetry-port.interface';
import { NoopTelemetryClientAdapter } from './adapters/noop-telemetry-client.adapter';
import { HttpTelemetryClientAdapter } from './adapters/http-telemetry-client.adapter';
import { PosthogTelemetryClientAdapter } from './adapters/posthog-telemetry-client.adapter';

@Injectable()
export class TelemetryClientFactory {
  private readonly logger = new Logger(TelemetryClientFactory.name);

  constructor(private configService: ConfigService) {}

  createTelemetryClient(): TelemetryPort {
    const telemetryEnabled = this.configService.get('BETTERDB_TELEMETRY');
    if (telemetryEnabled === false || telemetryEnabled === 'false') {
      return new NoopTelemetryClientAdapter();
    }

    const provider = this.configService.get<string>('TELEMETRY_PROVIDER', 'posthog');

    switch (provider) {
      case 'noop':
        return new NoopTelemetryClientAdapter();

      case 'posthog': {
        const apiKey = this.configService.get<string>('POSTHOG_API_KEY');
        if (!apiKey) {
          this.logger.warn(
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
        const telemetryPath = url.pathname.replace(/\/entitlements$/, '/telemetry');
        if (telemetryPath === url.pathname) {
          this.logger.warn(
            `ENTITLEMENT_URL path "${url.pathname}" does not end with "/entitlements". ` +
              'Cannot derive telemetry endpoint. Falling back to noop telemetry.',
          );
          return new NoopTelemetryClientAdapter();
        }
        url.pathname = telemetryPath;
        return new HttpTelemetryClientAdapter(url.toString());
      }

      default:
        this.logger.warn(
          `Unknown TELEMETRY_PROVIDER value. Falling back to noop telemetry.`,
        );
        return new NoopTelemetryClientAdapter();
    }
  }
}
