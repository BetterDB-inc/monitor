import { Module } from '@nestjs/common';
import { ClusterDiscoveryService } from './cluster-discovery.service';
import { ClusterMetricsService } from './cluster-metrics.service';
import { ClusterNodeConnectController } from './cluster-node-connect.controller';
import { ClusterNodeConnectService } from './cluster-node-connect.service';
import { ShardLoadService } from './shard-load.service';

@Module({
  controllers: [ClusterNodeConnectController],
  providers: [ClusterDiscoveryService, ClusterMetricsService, ShardLoadService, ClusterNodeConnectService],
  exports: [ClusterDiscoveryService, ClusterMetricsService, ShardLoadService],
})
export class ClusterModule {}
