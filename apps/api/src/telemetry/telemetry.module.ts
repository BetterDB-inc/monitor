import { Module } from '@nestjs/common';
import { TelemetryController } from './telemetry.controller';
import { UsageTelemetryService } from './usage-telemetry.service';

@Module({
  controllers: [TelemetryController],
  providers: [UsageTelemetryService],
  exports: [UsageTelemetryService],
})
export class TelemetryModule {}
