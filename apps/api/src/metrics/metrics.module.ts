import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AgentReadOnlyFilter } from '../common/filters/agent-read-only.filter';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { CommandstatsController } from './commandstats.controller';
import { CommandstatsPollerService } from './commandstats-poller.service';
import { LatencystatsController } from './latencystats.controller';
import { LatencystatsPollerService } from './latencystats-poller.service';
import { ClusterModule } from '../cluster/cluster.module';
import { StorageModule } from '../storage/storage.module';
import { ConnectionsModule } from '../connections/connections.module';
import { PrometheusModule } from '../prometheus/prometheus.module';

@Module({
  imports: [ClusterModule, StorageModule, ConnectionsModule, PrometheusModule],
  controllers: [MetricsController, CommandstatsController, LatencystatsController],
  providers: [
    MetricsService,
    CommandstatsPollerService,
    LatencystatsPollerService,
    // Global: a read-only agent connection's refusal is a 403 on every route.
    { provide: APP_FILTER, useClass: AgentReadOnlyFilter },
  ],
  exports: [MetricsService],
})
export class MetricsModule {}
