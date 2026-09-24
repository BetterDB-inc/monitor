import { Module } from '@nestjs/common';
import { FleetController } from './fleet.controller';
import { FleetService } from './fleet.service';
import { HealthModule } from '../health/health.module';
import { MetricsModule } from '../metrics/metrics.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [HealthModule, MetricsModule, StorageModule],
  controllers: [FleetController],
  providers: [FleetService],
  exports: [FleetService],
})
export class FleetModule {}
