import { Module } from '@nestjs/common';
import { ClusterDiscoveryService } from './cluster-discovery.service';
import { ClusterMetricsService } from './cluster-metrics.service';
import { ClusterAutoRegistrationService } from './auto-registration/cluster-auto-registration.service';

@Module({
  providers: [ClusterDiscoveryService, ClusterMetricsService, ClusterAutoRegistrationService],
  exports: [ClusterDiscoveryService, ClusterMetricsService],
})
export class ClusterModule {}
