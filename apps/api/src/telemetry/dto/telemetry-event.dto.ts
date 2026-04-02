import { IsIn, IsObject } from 'class-validator';
import { FRONTEND_TELEMETRY_EVENTS, FrontendTelemetryEvent } from '@betterdb/shared';

export class TelemetryEventDto {
  @IsIn(FRONTEND_TELEMETRY_EVENTS)
  eventType: FrontendTelemetryEvent;

  @IsObject()
  payload: Record<string, unknown>;
}
