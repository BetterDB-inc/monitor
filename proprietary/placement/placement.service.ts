import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PLACEMENT_DEFAULT_MODE,
  PLACEMENT_MODES,
  PLACEMENT_SETTABLE_MODES,
  type PlacementMode,
  type PlacementStatus,
  type PlacementSupport,
  type PlacementSupportReason,
} from '@betterdb/shared';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { dialsDataNodes } from '@app/connections/data-node-reach';
import { PrometheusService } from '@app/prometheus/prometheus.service';
import { ShardLoadService } from '@app/cluster/shard-load.service';
import { ClusterMetricsService } from '@app/cluster/cluster-metrics.service';
import { WORKSPACE_CONFIG, type WorkspaceConfig } from '@app/auth/workspace-config';
import { isManagedProviderBuild } from '@app/monitor/provider-detector';
import { AnomalyService } from '../anomaly-detection/anomaly.service';
import type { ServedHotShardDetail } from '../anomaly-detection/hot-shard-detector';
import type { RebalanceExecution } from '../anomaly-detection/rebalance-planner';
import { judgePlacementSupport, managedPlacementProvider } from './placement-support';
import { placementBalance } from './placement-balance';

const SUPPORT_CACHE_MS = 30_000;

export class PlacementModeError extends Error {
  constructor(
    message: string,
    readonly blockedBy: PlacementSupportReason | null = null,
  ) {
    super(message);
  }
}

@Injectable()
export class PlacementService {
  private readonly supportCache = new Map<string, { at: number; support: PlacementSupport }>();
  private readonly supportReads = new Map<string, Promise<PlacementSupport>>();
  private readonly aclDenied = new Set<string>();

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly registry: ConnectionRegistry,
    private readonly anomaly: AnomalyService,
    private readonly config: ConfigService,
    private readonly prometheus: PrometheusService,
    @Optional() @Inject(WORKSPACE_CONFIG) private readonly workspace?: WorkspaceConfig,
    @Optional() private readonly shardLoad?: ShardLoadService,
    @Optional() private readonly clusterMetrics?: ClusterMetricsService,
  ) {}

  async getStatus(connectionId: string): Promise<PlacementStatus> {
    const seedId = this.seedOf(connectionId);
    const [mode, support] = await Promise.all([this.storedMode(seedId), this.support(seedId)]);
    const selectableModes = PLACEMENT_SETTABLE_MODES.filter((each) => support.modes[each].available);
    return {
      connectionId: seedId,
      mode,
      effectiveMode: effectiveModeOf(mode, support),
      selectableModes,
      support,
      balance: placementBalance(this.shardLoad?.getLatest(seedId) ?? null),
    };
  }

  async setMode(connectionId: string, mode: PlacementMode): Promise<PlacementStatus> {
    if (!PLACEMENT_SETTABLE_MODES.includes(mode)) {
      throw new PlacementModeError(`The ${mode} mode is not available yet`);
    }
    const seedId = this.seedOf(connectionId);
    const support = await this.support(seedId);
    const state = support.modes[mode];
    if (!state.available) {
      const issue = support.issues.find((each) => each.reason === state.blockedBy);
      throw new PlacementModeError(issue?.detail ?? `The ${mode} mode is not supported here`, state.blockedBy);
    }
    await this.storage.savePlacementPolicy({ connectionId: seedId, mode, updatedAt: Date.now() });
    return this.getStatus(seedId);
  }

  async allowsRun(connectionId: string): Promise<boolean> {
    return (await this.runningMode(this.seedOf(connectionId))) !== 'observe';
  }

  async withPlacementBlocker(
    connectionId: string,
    shards: ServedHotShardDetail[],
  ): Promise<ServedHotShardDetail[]> {
    const runnable = (shard: ServedHotShardDetail) =>
      shard.rebalance?.kind === 'plan' && shard.rebalance.execution?.available === true;
    if (!shards.some(runnable)) return shards;
    const mode = await this.readableMode(connectionId);
    if (mode !== null && mode !== 'observe') return shards;
    const execution: RebalanceExecution =
      mode === 'observe' ? { available: false, blockedBy: 'observe_mode' } : { available: false };
    return shards.map((shard) =>
      runnable(shard) && shard.rebalance?.kind === 'plan'
        ? { ...shard, rebalance: { ...shard.rebalance, execution } }
        : shard,
    );
  }

  noteRebalanceRefusal(connectionId: string, message: string): void {
    if (!/\bNOPERM\b/i.test(message)) return;
    const seedId = this.seedOf(connectionId);
    this.aclDenied.add(seedId);
    this.supportCache.delete(seedId);
  }

  private seedOf(connectionId: string): string {
    const config = this.registry.getConfig(connectionId);
    if (!config) throw new NotFoundException(`Connection ${connectionId} not found`);
    return config.membership?.seedId ?? connectionId;
  }

  private async readableMode(connectionId: string): Promise<PlacementMode | null> {
    try {
      return await this.runningMode(this.seedOf(connectionId));
    } catch {
      return null;
    }
  }

  private async runningMode(seedId: string): Promise<PlacementMode> {
    const [mode, support] = await Promise.all([this.storedMode(seedId), this.support(seedId)]);
    return effectiveModeOf(mode, support);
  }

  private async storedMode(seedId: string): Promise<PlacementMode> {
    const stored = (await this.storage.getPlacementPolicy(seedId))?.mode;
    if (stored) return stored;
    return this.memoryStorage() && this.clusterEnabled(seedId) ? 'recommend' : PLACEMENT_DEFAULT_MODE;
  }

  private clusterEnabled(seedId: string): boolean {
    if (!this.registry.getConfig(seedId)) return false;
    try {
      return this.registry.get(seedId).getCapabilities().clusterEnabled === true;
    } catch {
      return false;
    }
  }

  private memoryStorage(): boolean {
    return String(this.config.get('STORAGE_TYPE') ?? 'memory') === 'memory';
  }

  private async support(seedId: string): Promise<PlacementSupport> {
    const cached = this.supportCache.get(seedId);
    if (cached && Date.now() - cached.at < SUPPORT_CACHE_MS) return cached.support;
    const inFlight = this.supportReads.get(seedId);
    if (inFlight) return inFlight;
    const read = this.judge(seedId)
      .then((support) => {
        this.supportCache.set(seedId, { at: Date.now(), support });
        return support;
      })
      .finally(() => this.supportReads.delete(seedId));
    this.supportReads.set(seedId, read);
    return read;
  }

  private async judge(seedId: string): Promise<PlacementSupport> {
    const config = this.registry.getConfig(seedId);
    const client = this.registry.get(seedId);
    const clusterEnabled = client.getCapabilities().clusterEnabled === true;
    const dialed = dialsDataNodes(config);
    const [clusterWide, primaries] = clusterEnabled
      ? await Promise.all([
          this.clusterMetrics?.usesClusterWideSlotStats(seedId) ?? Promise.resolve(true),
          dialed ? this.anomaly.readPlacementPrimaries(seedId) : Promise.resolve(null),
        ])
      : [true, null];
    const managedBuild = primaries?.find((primary) => isManagedProviderBuild(primary.serverInfo));
    return judgePlacementSupport({
      clusterEnabled,
      managedProvider: managedPlacementProvider(config?.host, managedBuild?.serverInfo),
      clusterWideView: clusterWide !== false,
      slotStats: this.prometheus.collectsClusterSlotStats(seedId, client),
      dialsDataNodes: dialed,
      primaries,
      aclDenied: this.aclDenied.has(seedId),
      slotMigrationFlag: String(this.config.get('BETTERDB_SLOT_MIGRATION')) === 'true',
      memoryStorage: this.memoryStorage(),
      signIn: this.workspace?.enabled === true,
    });
  }
}

function effectiveModeOf(mode: PlacementMode, support: PlacementSupport): PlacementMode {
  const ladder = PLACEMENT_MODES.slice(0, PLACEMENT_MODES.indexOf(mode) + 1).reverse();
  return ladder.find((each) => support.modes[each].available) ?? 'observe';
}
