import { Module } from '@nestjs/common';
import { ClusterDiscoveryService } from './cluster-discovery.service';
import { ClusterMetricsService } from './cluster-metrics.service';

@Module({
  providers: [ClusterDiscoveryService, ClusterMetricsService],
  exports: [ClusterDiscoveryService, ClusterMetricsService],
})
export class ClusterModule {}
