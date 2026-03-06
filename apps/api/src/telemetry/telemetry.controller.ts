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
      await this.usageTelemetry.trackInteractionAfterIdle(body.payload?.idleDurationMs as number);
    } else if (body.eventType === 'page_view') {
      await this.usageTelemetry.trackPageView(body.payload?.path as string);
    }

    return { ok: true };
  }
}
