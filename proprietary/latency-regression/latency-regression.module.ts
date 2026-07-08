import { Module } from '@nestjs/common';
import { StorageModule } from '@app/storage/storage.module';
import { LatencyRegressionService } from './latency-regression.service';

@Module({
  imports: [StorageModule],
  providers: [LatencyRegressionService],
  exports: [LatencyRegressionService],
})
export class LatencyRegressionModule {}
