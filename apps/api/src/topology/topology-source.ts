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
  /**
   * `registeredNodeIds` are the node ids of the seed's active members, so a
   * source that remembers per-seed state can start from what is registered
   * after a monitor restart.
   */
  discover(
    seed: DatabaseConnectionConfig,
    timeoutMs: number,
    registeredNodeIds?: ReadonlySet<string>,
  ): Promise<TopologyDiscovery | null>;
  /** Drop whatever the source remembers about a seed that was removed. */
  forget?(seedId: string): void;
}

export const TOPOLOGY_SOURCES = Symbol('TOPOLOGY_SOURCES');
