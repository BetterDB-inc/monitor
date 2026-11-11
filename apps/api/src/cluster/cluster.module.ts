import { Module } from '@nestjs/common';
import { ClusterDiscoveryService } from './cluster-discovery.service';
import { ClusterMetricsService } from './cluster-metrics.service';
import { ShardLoadService } from './shard-load.service';

@Module({
  providers: [ClusterDiscoveryService, ClusterMetricsService, ShardLoadService],
  exports: [ClusterDiscoveryService, ClusterMetricsService, ShardLoadService],
})
export class ClusterModule {}
