import { Controller, Post, Get, Body, BadRequestException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LicenseService } from '@proprietary/licenses';
import { UsageTelemetryService } from './usage-telemetry.service';

interface TelemetryConfig {
  instanceId: string;
  telemetryEnabled: boolean;
  provider: string;
  posthogApiKey?: string;
  posthogHost?: string;
}

const ALLOWED_EVENT_TYPES = ['interaction_after_idle', 'page_view', 'connection_switch'] as const;
type AllowedEventType = (typeof ALLOWED_EVENT_TYPES)[number];

@Controller('telemetry')
export class TelemetryController {
  constructor(
    private readonly usageTelemetry: UsageTelemetryService,
    private readonly configService: ConfigService,
    @Optional() private readonly licenseService?: LicenseService,
  ) {}

  @Get('config')
  getConfig(): TelemetryConfig {
    const provider = this.configService.get<string>('TELEMETRY_PROVIDER', 'posthog');
    const rawTelemetryConfig = this.configService.get('BETTERDB_TELEMETRY');
    const telemetryEnabled = rawTelemetryConfig !== false && rawTelemetryConfig !== 'false';
    const instanceId = this.licenseService?.getInstanceId() ?? '';

    const config: TelemetryConfig = {
      instanceId,
      telemetryEnabled,
      provider,
    };

    if (provider === 'posthog') {
      const apiKey = this.configService.get<string>('POSTHOG_API_KEY');
      const host = this.configService.get<string>('POSTHOG_HOST');
      if (apiKey) config.posthogApiKey = apiKey;
      if (host) config.posthogHost = host;
    }

    return config;
  }

  @Post('event')
  async trackEvent(
    @Body() body: { eventType: string; payload: Record<string, unknown> },
  ): Promise<{ ok: true }> {
    if (!ALLOWED_EVENT_TYPES.includes(body.eventType as AllowedEventType)) {
      throw new BadRequestException(`Invalid eventType: ${body.eventType}`);
    }

    if (body.eventType === 'interaction_after_idle') {
      const idleDurationMs = body.payload?.idleDurationMs;
      if (typeof idleDurationMs !== 'number') {
        throw new BadRequestException('payload.idleDurationMs must be a number');
      }
      await this.usageTelemetry.trackInteractionAfterIdle(idleDurationMs);
    } else if (body.eventType === 'page_view') {
      const path = body.payload?.path;
      if (typeof path !== 'string') {
        throw new BadRequestException('payload.path must be a string');
      }
      await this.usageTelemetry.trackPageView(path);
    } else if (body.eventType === 'connection_switch') {
      const totalConnections = body.payload?.totalConnections;
      if (typeof totalConnections !== 'number') {
        throw new BadRequestException('payload.totalConnections must be a number');
      }
      const dbType = typeof body.payload?.dbType === 'string' ? body.payload.dbType : 'unknown';
      const dbVersion =
        typeof body.payload?.dbVersion === 'string' ? body.payload.dbVersion : 'unknown';
      await this.usageTelemetry.trackDbSwitch(totalConnections, dbType, dbVersion);
    }

    return { ok: true };
  }
}
