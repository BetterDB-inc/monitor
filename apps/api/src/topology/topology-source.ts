import type { DatabaseConnectionConfig, TopologyKind } from '@betterdb/shared';
import type { DatabaseCapabilities } from '../common/interfaces/database-port.interface';
import type { DesiredNode } from './membership-diff';

export interface TopologyDiscovery {
  nodes: DesiredNode[];
  unknownGroups: string[];
}

export interface TopologySource {
  readonly kind: TopologyKind;
  readonly envFlag: string;
  handles(caps: DatabaseCapabilities): boolean;
  discover(seed: DatabaseConnectionConfig, timeoutMs: number): Promise<TopologyDiscovery>;
}

export const TOPOLOGY_SOURCES = Symbol('TOPOLOGY_SOURCES');
