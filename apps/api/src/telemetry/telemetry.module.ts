import { Module, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TelemetryController } from './telemetry.controller';
import { UsageTelemetryService } from './usage-telemetry.service';
import { TelemetryClientFactory } from './telemetry-client.factory';
import { TelemetryPort } from '../common/interfaces/telemetry-port.interface';

@Module({
  imports: [ConfigModule],
  controllers: [TelemetryController],
  providers: [
    TelemetryClientFactory,
    {
      provide: 'TELEMETRY_CLIENT',
      useFactory: (factory: TelemetryClientFactory): TelemetryPort => {
        return factory.createTelemetryClient();
      },
      inject: [TelemetryClientFactory],
    },
    UsageTelemetryService,
  ],
  exports: [UsageTelemetryService],
})
export class TelemetryModule implements OnModuleDestroy {
  constructor(@Inject('TELEMETRY_CLIENT') private readonly telemetryClient: TelemetryPort) {}

  async onModuleDestroy(): Promise<void> {
    await this.telemetryClient.shutdown();
  }
}
