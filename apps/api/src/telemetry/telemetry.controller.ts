import { Controller, Post, Get, Body, BadRequestException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LicenseService } from '@proprietary/licenses';
import { FrontendTelemetryEvent } from '@betterdb/shared';
import { UsageTelemetryService } from './usage-telemetry.service';
import { TelemetryEventDto } from './dto/telemetry-event.dto';

interface TelemetryConfig {
  instanceId: string;
  telemetryEnabled: boolean;
  provider: string;
}

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

    return config;
  }

  @Post('event')
  async trackEvent(@Body() body: TelemetryEventDto): Promise<{ ok: true }> {
    switch (body.eventType as FrontendTelemetryEvent) {
      case 'interaction_after_idle':
        await this.handleInteractionAfterIdle(body.payload);
        break;
      case 'page_view':
        await this.handlePageView(body.payload);
        break;
      case 'connection_switch':
        await this.handleConnectionSwitch(body.payload);
        break;
      default:
        throw new BadRequestException(`Unhandled eventType: ${body.eventType}`);
    }

    return { ok: true };
  }

  private async handleInteractionAfterIdle(payload: Record<string, unknown>): Promise<void> {
    const idleDurationMs = payload?.idleDurationMs;
    if (typeof idleDurationMs !== 'number') {
      throw new BadRequestException('payload.idleDurationMs must be a number');
    }
    await this.usageTelemetry.trackInteractionAfterIdle(idleDurationMs);
  }

  private async handlePageView(payload: Record<string, unknown>): Promise<void> {
    const path = payload?.path;
    if (typeof path !== 'string') {
      throw new BadRequestException('payload.path must be a string');
    }
    await this.usageTelemetry.trackPageView(path);
  }

  private async handleConnectionSwitch(payload: Record<string, unknown>): Promise<void> {
    const totalConnections = payload?.totalConnections;
    if (typeof totalConnections !== 'number') {
      throw new BadRequestException('payload.totalConnections must be a number');
    }
    const dbType = typeof payload?.dbType === 'string' ? payload.dbType : 'unknown';
    const dbVersion = typeof payload?.dbVersion === 'string' ? payload.dbVersion : 'unknown';
    await this.usageTelemetry.trackDbSwitch(totalConnections, dbType, dbVersion);
  }
}
