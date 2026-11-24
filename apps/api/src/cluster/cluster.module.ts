import { Module } from '@nestjs/common';
import { ClusterDiscoveryService } from './cluster-discovery.service';
import { ClusterIdentityService } from './cluster-identity.service';
import { ClusterMetricsService } from './cluster-metrics.service';
import { ClusterNodeConnectController } from './cluster-node-connect.controller';
import { ClusterNodeConnectService } from './cluster-node-connect.service';
import { ShardLoadService } from './shard-load.service';

@Module({
  controllers: [ClusterNodeConnectController],
  providers: [
    ClusterDiscoveryService,
    ClusterIdentityService,
    ClusterMetricsService,
    ShardLoadService,
    ClusterNodeConnectService,
  ],
  exports: [ClusterDiscoveryService, ClusterIdentityService, ClusterMetricsService, ShardLoadService],
})
export class ClusterModule {}
