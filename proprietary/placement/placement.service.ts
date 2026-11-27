import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_PLACEMENT_SETTINGS,
  PLACEMENT_DEFAULT_MODE,
  PLACEMENT_MODES,
  PLACEMENT_SETTABLE_MODES,
  excludedShardNodeIds,
  validatePlacementSettings,
  type PlacementMode,
  type PlacementPolicy,
  type PlacementPolicyInvalid,
  type PlacementPolicySaved,
  type PlacementSettings,
  type PlacementStatus,
  type PlacementSupport,
  type PlacementSupportReason,
} from '@betterdb/shared';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { dialsDataNodes } from '@app/connections/data-node-reach';
import { PrometheusService } from '@app/prometheus/prometheus.service';
import { ShardLoadService } from '@app/cluster/shard-load.service';
import type { ShardLoadSample } from '@app/cluster/shard-load';
import { ClusterMetricsService } from '@app/cluster/cluster-metrics.service';
import { WORKSPACE_CONFIG, type WorkspaceConfig } from '@app/auth/workspace-config';
import { isManagedProviderBuild } from '@app/monitor/provider-detector';
import { withTimeout } from '@app/common/utils/with-timeout';
import { AnomalyService } from '../anomaly-detection/anomaly.service';
import type { ServedHotShardDetail } from '../anomaly-detection/hot-shard-detector';
import {
  DEFAULT_REBALANCE_POLICY,
  type RebalanceExecution,
  type RebalancePolicy,
} from '../anomaly-detection/rebalance-planner';
import type {
  ConfirmedMove,
  RebalanceRunActor,
  RebalanceRunResult,
} from '../anomaly-detection/slot-rebalance-run';
import {
  isAclRefusal,
  judgePlacementSupport,
  judgeUnconnectedPlacement,
  managedPlacementProvider,
  type PlacementPrimaryRead,
} from './placement-support';
import { placementBalance } from './placement-balance';

const SUPPORT_CACHE_MS = 30_000;
const POLICY_CACHE_MS = 30_000;
const SHARD_NODES_TIMEOUT_MS = 2_000;

export class PlacementModeError extends Error {
  constructor(
    message: string,
    readonly blockedBy: PlacementSupportReason | null = null,
  ) {
    super(message);
  }
}

export class PlacementPolicyError extends Error {
  constructor(readonly errors: string[]) {
    super(`The placement policy is not valid: ${errors.join('; ')}`);
  }
}

export class PlacementPolicyConflictError extends Error {
  constructor() {
    super('The placement policy changed since it was read');
  }
}

export class PlacementPolicyUnreadableError extends Error {
  constructor(readonly problems: string[]) {
    super(`The exclusions of the stored placement policy cannot be read: ${problems.join('; ')}`);
  }
}

export interface PlacementSettingsRead {
  settings: PlacementSettings;
  version: number;
  invalid: PlacementPolicyInvalid | null;
}

export function rebalancePolicyOf(settings: PlacementSettings): RebalancePolicy {
  return {
    ...DEFAULT_REBALANCE_POLICY,
    nodeCpuLimitUsecPerSecond: settings.nodeCpuLimitUsecPerSecond,
    resolveRatio: settings.resolveRatio,
    excludedShardIds: settings.excludedShardIds,
    excludedSlots: settings.excludedSlots,
  };
}

function settingsReadOf(policy: PlacementPolicy | null): PlacementSettingsRead {
  return {
    settings: policy?.settings ?? DEFAULT_PLACEMENT_SETTINGS,
    version: policy?.version ?? 0,
    invalid: policy?.invalid ?? null,
  };
}

@Injectable()
export class PlacementService implements OnModuleInit {
  private readonly logger = new Logger(PlacementService.name);
  private readonly invalidWarned = new Map<string, string>();
  private readonly policyCache = new Map<string, { at: number; policy: PlacementPolicy | null }>();
  private readonly policyGeneration = new Map<string, number>();
  private readonly supportCache = new Map<string, { at: number; support: PlacementSupport }>();
  private readonly supportReads = new Map<string, Promise<PlacementSupport>>();
  private readonly aclDenied = new Map<string, string | null>();

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

  onModuleInit(): void {
    this.anomaly.setRebalancePolicyResolver((seedId) => this.rebalancePolicyFor(seedId));
  }

  async getStatus(connectionId: string): Promise<PlacementStatus> {
    const seedId = this.seedOf(connectionId);
    const [policy, support] = await Promise.all([this.readPolicy(seedId), this.support(seedId)]);
    const mode = this.modeOf(policy, seedId);
    const { settings, version, invalid } = settingsReadOf(policy);
    const selectableModes = PLACEMENT_SETTABLE_MODES.filter((each) => support.modes[each].available);
    return {
      connectionId: seedId,
      mode,
      effectiveMode: effectiveModeOf(mode, support),
      selectableModes,
      support,
      balance: placementBalance(this.freshSample(seedId), settings),
      settings,
      policyVersion: version,
      policyInvalid: invalid,
    };
  }

  async setSettings(
    connectionId: string,
    input: unknown,
    version: number,
  ): Promise<PlacementPolicySaved> {
    const validated = validatePlacementSettings(input);
    if (!validated.ok) throw new PlacementPolicyError(validated.errors);
    const seedId = this.seedOf(connectionId);
    const current = await this.storage.getPlacementPolicy(seedId);
    const expansion = await this.withShardNodes(seedId, validated.settings);
    const saved = await this.storage.savePlacementSettings(
      {
        connectionId: seedId,
        settings: expansion.settings,
        updatedAt: Date.now(),
        modeIfNew: this.modeOf(current, seedId),
      },
      version,
    );
    if (!saved) throw new PlacementPolicyConflictError();
    this.advancePolicy(seedId);
    this.policyCache.set(seedId, { at: Date.now(), policy: saved });
    return {
      ...(await this.getStatus(seedId)),
      exclusionsExpanded: expansion.problem === null,
      exclusionsExpandProblem: expansion.problem,
    };
  }

  private async withShardNodes(
    seedId: string,
    settings: PlacementSettings,
  ): Promise<{ settings: PlacementSettings; problem: string | null }> {
    if (settings.excludedShardIds.length === 0) return { settings, problem: null };
    try {
      const nodes = await withTimeout(
        this.registry.get(seedId).getClusterNodes(),
        SHARD_NODES_TIMEOUT_MS,
        `CLUSTER NODES did not answer within ${SHARD_NODES_TIMEOUT_MS / 1000} s`,
      );
      return {
        settings: {
          ...settings,
          excludedShardIds: excludedShardNodeIds(settings.excludedShardIds, nodes),
        },
        problem: null,
      };
    } catch (err) {
      const problem = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `The placement policy of ${seedId} was saved with the excluded shards as typed: the other nodes of each shard were not added (${problem}).`,
      );
      return { settings, problem };
    }
  }

  async settingsOf(
    seedId: string,
    { fresh = false }: { fresh?: boolean } = {},
  ): Promise<PlacementSettingsRead> {
    return settingsReadOf(fresh ? await this.readPolicy(seedId) : await this.cachedPolicy(seedId));
  }

  async rebalancePolicyFor(seedId: string): Promise<RebalancePolicy> {
    const { settings, invalid } = await this.settingsOf(seedId);
    if (invalid && !invalid.exclusionsReadable)
      throw new PlacementPolicyUnreadableError(invalid.problems);
    return rebalancePolicyOf(settings);
  }

  private async readPolicy(seedId: string): Promise<PlacementPolicy | null> {
    const generation = this.policyGeneration.get(seedId) ?? 0;
    const policy = await this.storage.getPlacementPolicy(seedId);
    if ((this.policyGeneration.get(seedId) ?? 0) === generation) {
      this.policyCache.set(seedId, { at: Date.now(), policy });
    }
    this.warnInvalid(seedId, policy);
    return policy;
  }

  private warnInvalid(seedId: string, policy: PlacementPolicy | null): void {
    if (!policy?.invalid) {
      this.invalidWarned.delete(seedId);
      return;
    }
    const key = `${policy.version}:${policy.invalid.problems.join('; ')}`;
    if (this.invalidWarned.get(seedId) === key) return;
    this.invalidWarned.set(seedId, key);
    this.logger.warn(
      `The stored placement policy of ${seedId} (version ${policy.version}) does not validate: ${policy.invalid.problems.join('; ')}. ` +
        (policy.invalid.exclusionsReadable
          ? 'The fields it could not read use their defaults until it is saved again.'
          : 'Its exclusions cannot be read, so no slot moves are planned until it is saved again.'),
    );
  }

  private async cachedPolicy(seedId: string): Promise<PlacementPolicy | null> {
    const cached = this.policyCache.get(seedId);
    if (cached && Date.now() - cached.at < POLICY_CACHE_MS) return cached.policy;
    return this.readPolicy(seedId);
  }

  private advancePolicy(seedId: string): void {
    this.policyGeneration.set(seedId, (this.policyGeneration.get(seedId) ?? 0) + 1);
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
    await this.storage.savePlacementMode({ connectionId: seedId, mode, updatedAt: Date.now() });
    this.advancePolicy(seedId);
    this.policyCache.delete(seedId);
    return this.getStatus(seedId);
  }

  async allowsRun(connectionId: string): Promise<boolean> {
    return (await this.runningMode(this.seedOf(connectionId))) !== 'observe';
  }

  async runRebalance(
    connectionId: string,
    shardId: string,
    confirmed: readonly ConfirmedMove[],
    startedBy: RebalanceRunActor,
  ): Promise<RebalanceRunResult> {
    if (!(await this.allowsRun(connectionId))) {
      return { status: 'blocked', blockedBy: 'observe_mode' };
    }
    const result = await this.anomaly.runRebalance(connectionId, shardId, confirmed, startedBy);
    if (result.status === 'refused' && result.serverReply && isAclRefusal(result.message)) {
      const seedId = this.seedOf(connectionId);
      this.aclDenied.set(seedId, null);
      this.supportCache.delete(seedId);
      this.supportReads.delete(seedId);
    }
    return result;
  }

  async withPlacementBlocker(
    connectionId: string,
    shards: ServedHotShardDetail[],
  ): Promise<ServedHotShardDetail[]> {
    if (!shards.some((shard) => namesAPlan(shard.rebalance))) return shards;
    const mode = await this.readableMode(connectionId);
    if (mode === 'observe') {
      return shards.map((shard) =>
        namesAPlan(shard.rebalance) ? { ...shard, rebalance: undefined } : shard,
      );
    }
    if (mode !== null) return shards;
    const execution: RebalanceExecution = { available: false };
    return shards.map((shard) =>
      shard.rebalance?.kind === 'plan' && shard.rebalance.execution?.available === true
        ? { ...shard, rebalance: { ...shard.rebalance, execution } }
        : shard,
    );
  }

  private seedOf(connectionId: string): string {
    const config = this.registry.getConfig(connectionId);
    if (!config) throw new NotFoundException(`Connection ${connectionId} not found`);
    return config.membership?.seedId ?? connectionId;
  }

  private freshSample(seedId: string): ShardLoadSample | null {
    const sample = this.shardLoad?.getLatest(seedId) ?? null;
    if (!sample) return null;
    return Date.now() - sample.timestamp <= this.prometheus.shardLoadStalenessMs ? sample : null;
  }

  private async readableMode(connectionId: string): Promise<PlacementMode | null> {
    try {
      return await this.runningMode(this.seedOf(connectionId));
    } catch {
      return null;
    }
  }

  private async runningMode(seedId: string): Promise<PlacementMode> {
    const mode = await this.storedMode(seedId);
    if (mode === 'observe') return 'observe';
    const support =
      mode === 'recommend' ? await this.readOnlySupport(seedId) : await this.support(seedId);
    return effectiveModeOf(mode, support);
  }

  private async readOnlySupport(seedId: string): Promise<PlacementSupport> {
    const cached = this.supportCache.get(seedId);
    if (cached && Date.now() - cached.at < SUPPORT_CACHE_MS) return cached.support;
    return this.judge(seedId, false);
  }

  private async storedMode(seedId: string): Promise<PlacementMode> {
    return this.modeOf(await this.storage.getPlacementPolicy(seedId), seedId);
  }

  private modeOf(policy: PlacementPolicy | null, seedId: string): PlacementMode {
    if (policy) return policy.mode;
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
    this.forgetRemovedConnections();
    const cached = this.supportCache.get(seedId);
    if (cached && Date.now() - cached.at < SUPPORT_CACHE_MS) return cached.support;
    const inFlight = this.supportReads.get(seedId);
    if (inFlight) return inFlight;
    const read = this.judge(seedId, true).finally(() => {
      if (this.supportReads.get(seedId) === read) this.supportReads.delete(seedId);
    });
    this.supportReads.set(seedId, read);
    return read;
  }

  private forgetRemovedConnections(): void {
    for (const cache of [
      this.supportCache,
      this.supportReads,
      this.aclDenied,
      this.policyCache,
      this.policyGeneration,
      this.invalidWarned,
    ]) {
      for (const seedId of cache.keys()) {
        if (!this.registry.getConfig(seedId)) cache.delete(seedId);
      }
    }
  }

  private noteTopology(seedId: string, primaries: PlacementPrimaryRead[] | null): boolean {
    if (!this.aclDenied.has(seedId)) return false;
    if (!primaries || primaries.length === 0) return true;
    const topology = primaries
      .map((primary) => primary.address)
      .sort()
      .join(',');
    const deniedAt = this.aclDenied.get(seedId);
    if (deniedAt === null) {
      this.aclDenied.set(seedId, topology);
      return true;
    }
    if (deniedAt === topology) return true;
    this.aclDenied.delete(seedId);
    return false;
  }

  private async judge(seedId: string, readPrimaries: boolean): Promise<PlacementSupport> {
    const config = this.registry.getConfig(seedId);
    const client = this.registry.get(seedId);
    let clusterEnabled: boolean;
    try {
      clusterEnabled = client.getCapabilities().clusterEnabled === true;
    } catch {
      return judgeUnconnectedPlacement();
    }
    const dialed = dialsDataNodes(config);
    const [clusterWide, primaries] = clusterEnabled
      ? await Promise.all([
          this.clusterMetrics?.usesClusterWideSlotStats(seedId) ?? Promise.resolve(true),
          dialed && readPrimaries
            ? this.anomaly.readPlacementPrimaries(seedId)
            : Promise.resolve(null),
        ])
      : [true, null];
    const managedBuild = primaries?.find((primary) => isManagedProviderBuild(primary.serverInfo));
    const support = judgePlacementSupport({
      clusterEnabled,
      managedProvider: managedPlacementProvider(config?.host, managedBuild?.serverInfo),
      clusterWideView: clusterWide !== false,
      slotStats:
        this.prometheus.collectsClusterSlotStats(seedId, client) &&
        this.shardLoad?.reportsUsage(seedId) !== false,
      dialsDataNodes: dialed,
      primaries,
      aclDenied: readPrimaries ? this.noteTopology(seedId, primaries) : this.aclDenied.has(seedId),
      slotMigrationFlag: String(this.config.get('BETTERDB_SLOT_MIGRATION')) === 'true',
      memoryStorage: this.memoryStorage(),
      signIn: this.workspace?.enabled === true,
    });
    if (readPrimaries && !support.issues.some((issue) => issue.reason === 'not_connected')) {
      this.supportCache.set(seedId, { at: Date.now(), support });
    }
    return support;
  }
}

function namesAPlan(rebalance: ServedHotShardDetail['rebalance']): boolean {
  if (rebalance?.kind === 'plan') return true;
  return (
    rebalance?.kind === 'no_plan' &&
    (rebalance.reason === 'covered_by_other_plan' ||
      rebalance.reason === 'conflicts_with_other_plan')
  );
}

function effectiveModeOf(mode: PlacementMode, support: PlacementSupport): PlacementMode {
  const ladder = PLACEMENT_MODES.slice(0, PLACEMENT_MODES.indexOf(mode) + 1).reverse();
  return ladder.find((each) => support.modes[each].available) ?? 'observe';
}
