import { Module } from '@nestjs/common';
import { StorageModule } from '@app/storage/storage.module';
import { LatencyRegressionService } from './latency-regression.service';
import { AnomalyModule } from '../anomaly-detection/anomaly.module';

@Module({
  imports: [StorageModule, AnomalyModule],
  providers: [LatencyRegressionService],
  exports: [LatencyRegressionService],
})
export class LatencyRegressionModule {}
