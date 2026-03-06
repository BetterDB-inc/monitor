import { Controller, Post, Body, BadRequestException } from '@nestjs/common';
import { UsageTelemetryService } from './usage-telemetry.service';

const ALLOWED_EVENT_TYPES = ['interaction_after_idle', 'page_view'] as const;
type AllowedEventType = typeof ALLOWED_EVENT_TYPES[number];

@Controller('telemetry')
export class TelemetryController {
  constructor(private readonly usageTelemetry: UsageTelemetryService) {}

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
    }

    return { ok: true };
  }
}
