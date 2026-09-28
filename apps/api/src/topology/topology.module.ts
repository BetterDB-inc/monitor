import { Module } from '@nestjs/common';
import { ClusterModule } from '../cluster/cluster.module';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { ClusterTopologySource } from './cluster-topology.source';
import { SentinelTopologySource } from './sentinel-topology.source';
import { TopologyAutoRegistrationService } from './topology-auto-registration.service';
import { TOPOLOGY_SOURCES, TopologySource } from './topology-source';

@Module({
  imports: [ClusterModule],
  providers: [
    ClusterTopologySource,
    {
      provide: SentinelTopologySource,
      useFactory: (registry: ConnectionRegistry) => new SentinelTopologySource(registry),
      inject: [ConnectionRegistry],
    },
    {
      provide: TOPOLOGY_SOURCES,
      useFactory: (cluster: ClusterTopologySource, sentinel: SentinelTopologySource): TopologySource[] => [
        cluster,
        sentinel,
      ],
      inject: [ClusterTopologySource, SentinelTopologySource],
    },
    TopologyAutoRegistrationService,
  ],
})
export class TopologyModule {}
