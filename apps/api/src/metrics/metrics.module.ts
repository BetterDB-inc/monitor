import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { CommandstatsController } from './commandstats.controller';
import { CommandstatsPollerService } from './commandstats-poller.service';
import { ClusterModule } from '../cluster/cluster.module';
import { StorageModule } from '../storage/storage.module';
import { ConnectionsModule } from '../connections/connections.module';

@Module({
  imports: [ClusterModule, StorageModule, ConnectionsModule],
  controllers: [MetricsController, CommandstatsController],
  providers: [MetricsService, CommandstatsPollerService],
  exports: [MetricsService],
})
export class MetricsModule {}
