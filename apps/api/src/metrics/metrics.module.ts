import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { ClusterModule } from '../cluster/cluster.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [ClusterModule, StorageModule],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
