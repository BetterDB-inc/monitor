import { Module } from '@nestjs/common';
import { ClusterModule } from '../cluster/cluster.module';
import { ClusterTopologySource } from './cluster-topology.source';
import { TopologyAutoRegistrationService } from './topology-auto-registration.service';
import { TOPOLOGY_SOURCES, TopologySource } from './topology-source';

@Module({
  imports: [ClusterModule],
  providers: [
    ClusterTopologySource,
    {
      provide: TOPOLOGY_SOURCES,
      useFactory: (cluster: ClusterTopologySource): TopologySource[] => [cluster],
      inject: [ClusterTopologySource],
    },
    TopologyAutoRegistrationService,
  ],
})
export class TopologyModule {}
