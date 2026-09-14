import { Module } from '@nestjs/common';
import { FleetController } from './fleet.controller';
import { FleetService } from './fleet.service';
import { HealthModule } from '../health/health.module';
import { MetricsModule } from '../metrics/metrics.module';

@Module({
  imports: [HealthModule, MetricsModule],
  controllers: [FleetController],
  providers: [FleetService],
  exports: [FleetService],
})
export class FleetModule {}
