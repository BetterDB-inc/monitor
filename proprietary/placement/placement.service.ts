import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
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
  type PlacementGatePurpose,
  type PlacementGateResult,
  type PlacementMode,
  type PlacementPolicy,
  type PlacementPolicyInvalid,
  type PlacementPolicySaved,
  type PlacementRecommendation,
  type PlacementSettings,
  type PlacementStatus,
  type PlacementSupport,
  type PlacementSupportReason,
  type PlacementTriggerRead,
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
import type { ClusterNode } from '@app/common/types/metrics.types';
import { AnomalyService } from '../anomaly-detection/anomaly.service';
import type { ServedHotShardDetail } from '../anomaly-detection/hot-shard-detector';
import {
  DEFAULT_REBALANCE_POLICY,
  PlacementPolicyUnreadableError,
  type RebalanceExecution,
  type RebalancePlan,
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
import { PlacementTriggers } from './placement-trigger';
import { PLACEMENT_EPOCH_WINDOW_MS, placementGate } from './placement-gate';
import {
  PlacementEpochs,
  placementGateFactsOf,
  readPlacementCluster,
  type PlacementClusterRead,
} from './placement-facts';

const SUPPORT_CACHE_MS = 30_000;
const POLICY_CACHE_MS = 30_000;
const SHARD_NODES_TIMEOUT_MS = 2_000;
const GATE_CACHE_MS = 10_000;
const BUDGET_WINDOW_MS = 60 * 60_000;

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

export { PlacementPolicyUnreadableError };

export interface PlacementGateSubject {
  sourceShardId: string;
  targetShardIds: readonly string[];
  moveCount: number;
}

export interface PlacementGateOptions {
  now?: number;
  sourceTriggerFiredAt?: number | null;
  freshPolicy?: boolean;
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
export class PlacementService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlacementService.name);
  private readonly invalidWarned = new Map<string, string>();
  private readonly policyCache = new Map<string, { at: number; policy: PlacementPolicy | null }>();
  private readonly policyGeneration = new Map<string, number>();
  private readonly supportCache = new Map<string, { at: number; support: PlacementSupport }>();
  private readonly supportReads = new Map<string, Promise<PlacementSupport>>();
  private readonly aclDenied = new Map<string, string | null>();
  private readonly triggers = new PlacementTriggers();
  private readonly policyRefreshes = new Map<string, Promise<unknown>>();
  private readonly epochs = new PlacementEpochs();
  private readonly gateCache = new Map<
    string,
    { at: number; key: string; gate: PlacementGateResult }
  >();
  private readonly gateReads = new Map<
    string,
    { key: string; read: Promise<PlacementGateResult> }
  >();
  private stopListening: (() => void) | null = null;

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
    this.anomaly.setClusterNodesObserver((connectionId, nodes, at) =>
      this.observeEpochs(connectionId, nodes, at),
    );
    this.stopListening?.();
    this.stopListening =
      this.shardLoad?.addListener({
        tracking: (seedId) => this.refreshPolicy(seedId),
        sample: (seedId, sample) => this.observeSample(seedId, sample),
        reset: (seedId) => this.triggers.reset(seedId),
      }) ?? null;
  }

  onModuleDestroy(): void {
    this.stopListening?.();
    this.stopListening = null;
    this.anomaly.setClusterNodesObserver(null);
  }

  private observeEpochs(connectionId: string, nodes: readonly ClusterNode[], at: number): void {
    if (!this.epochs.has(connectionId)) return;
    const reads = nodes.flatMap((node) => {
      if (node.flags.includes('master')) {
        return [{ id: node.id, shardId: node.id, configEpoch: node.configEpoch }];
      }
      if (node.flags.includes('slave') || node.flags.includes('replica')) {
        return [{ id: node.id, shardId: node.master, configEpoch: node.configEpoch }];
      }
      return [];
    });
    this.epochs.observe(
      connectionId,
      reads,
      at,
      this.anomaly.placementMovedShardsSince(connectionId, at - PLACEMENT_EPOCH_WINDOW_MS),
    );
  }

  private observeSample(seedId: string, sample: ShardLoadSample): void {
    if (!this.registry.getConfig(seedId)) return;
    const cached = this.policyCache.get(seedId);
    if (!cached || Date.now() - cached.at >= POLICY_CACHE_MS) this.refreshPolicy(seedId);
    this.triggers.observe(seedId, sample, this.prometheus.shardLoadStalenessMs);
  }

  private refreshPolicy(seedId: string): void {
    if (this.policyRefreshes.has(seedId) || !this.registry.getConfig(seedId)) return;
    const refresh = this.readPolicy(seedId)
      .catch(() => null)
      .finally(() => this.policyRefreshes.delete(seedId));
    this.policyRefreshes.set(seedId, refresh);
  }

  async getStatus(connectionId: string): Promise<PlacementStatus> {
    const seedId = this.seedOf(connectionId);
    return this.statusOf(seedId, this.readPolicy(seedId));
  }

  private async statusOf(
    seedId: string,
    policyRead: Promise<PlacementPolicy | null> | PlacementPolicy,
  ): Promise<PlacementStatus> {
    const [policy, support] = await Promise.all([policyRead, this.support(seedId)]);
    const mode = this.modeOf(policy, seedId);
    const { settings, version, invalid } = settingsReadOf(policy);
    const selectableModes = PLACEMENT_SETTABLE_MODES.filter((each) => support.modes[each].available);
    const recommendations = mode === 'observe' ? [] : await this.recommendationsOf(seedId);
    return {
      connectionId: seedId,
      mode,
      effectiveMode: effectiveModeOf(mode, support),
      selectableModes,
      support,
      balance: placementBalance(this.freshSample(seedId), settings, (shardId) =>
        this.triggerOf(seedId, shardId),
      ),
      settings,
      policyVersion: version,
      policyInvalid: invalid,
      recommendations,
    };
  }

  private async recommendationsOf(seedId: string): Promise<PlacementRecommendation[]> {
    const plans = this.anomaly.placementPlans(seedId);
    const gates = await this.cachedGates(seedId, plans);
    return plans.map((plan, index) => ({
      sourceShardId: plan.sourceShardId,
      targetShardIds: targetsOf(plan.moves),
      gate: gates[index],
      execution: plan.execution ?? { available: false },
    }));
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
    if (expansion.problem !== null) {
      this.logger.warn(
        `The placement policy of ${seedId} was saved with the excluded shards as typed: the other nodes of each shard were not added (${expansion.problem}).`,
      );
    }
    this.advancePolicy(seedId);
    this.policyCache.set(seedId, { at: Date.now(), policy: saved });
    this.applyTriggerSettings(seedId, saved.settings);
    return {
      ...(await this.statusOf(seedId, saved)),
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
      return { settings, problem: err instanceof Error ? err.message : String(err) };
    }
  }

  async settingsOf(seedId: string): Promise<PlacementSettingsRead> {
    return settingsReadOf(await this.cachedPolicy(seedId));
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
    if (
      this.registry.getConfig(seedId) &&
      (this.policyGeneration.get(seedId) ?? 0) === generation
    ) {
      this.policyCache.set(seedId, { at: Date.now(), policy });
      this.applyTriggerSettings(seedId, settingsReadOf(policy).settings);
    }
    this.warnInvalid(seedId, policy);
    return policy;
  }

  private applyTriggerSettings(seedId: string, settings: PlacementSettings): void {
    this.shardLoad?.setSustainMinutes(seedId, settings.sustainMinutes);
    this.triggers.configure(seedId, settings);
  }

  triggerOf(seedId: string, shardId: string, now = Date.now()): PlacementTriggerRead | null {
    if (!this.shardLoad) return null;
    return this.triggers.read(seedId, shardId, now, this.prometheus.shardLoadStalenessMs);
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
    const gate = await this.gateFor(
      connectionId,
      { sourceShardId: shardId, targetShardIds: targetsOf(confirmed), moveCount: confirmed.length },
      'approve',
      { freshPolicy: true },
    ).catch(unreadableGate);
    if (!gate.allowed) return { status: 'blocked', blockedBy: 'gate', blockers: gate.blockers };
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
    if (mode !== null) {
      const runnable = shards.flatMap((shard) =>
        shard.rebalance?.kind === 'plan' && shard.rebalance.execution?.available === true
          ? [shard.rebalance]
          : [],
      );
      const gates = await this.cachedGates(connectionId, runnable);
      return shards.map((shard) => {
        const plan = shard.rebalance;
        const index = runnable.findIndex((each) => each === plan);
        if (plan?.kind !== 'plan' || index === -1) return shard;
        const gate = gates[index];
        const execution: RebalanceExecution = gate.allowed
          ? { available: true }
          : { available: false, blockedBy: 'gate' };
        return { ...shard, rebalance: { ...plan, execution, gate } };
      });
    }
    const execution: RebalanceExecution = { available: false };
    return shards.map((shard) =>
      shard.rebalance?.kind === 'plan' && shard.rebalance.execution?.available === true
        ? { ...shard, rebalance: { ...shard.rebalance, execution } }
        : shard,
    );
  }

  async gateFor(
    connectionId: string,
    subject: PlacementGateSubject,
    purpose: PlacementGatePurpose,
    options: PlacementGateOptions = {},
  ): Promise<PlacementGateResult> {
    const read = await readPlacementCluster(this.anomaly, connectionId, [
      subject.sourceShardId,
      ...subject.targetShardIds,
    ]);
    return this.judgeGate(connectionId, subject, purpose, read, options);
  }

  private async judgeGate(
    connectionId: string,
    subject: PlacementGateSubject,
    purpose: PlacementGatePurpose,
    read: PlacementClusterRead,
    { now = Date.now(), freshPolicy = false, ...options }: PlacementGateOptions = {},
  ): Promise<PlacementGateResult> {
    const seedId = this.seedOf(connectionId);
    const [{ settings, invalid }, support] = await Promise.all([
      freshPolicy ? this.readPolicy(seedId).then(settingsReadOf) : this.settingsOf(seedId),
      this.readOnlySupport(seedId),
    ]);
    const facts = placementGateFactsOf(
      read,
      this.epochs,
      connectionId,
      {
        budget: {
          jobsUsed: this.anomaly.placementJobsSince(connectionId, now - BUDGET_WINDOW_MS),
          bytesUsed: 0,
        },
        paused: false,
        supported: support.modes[purpose === 'auto' ? 'auto' : 'recommend'].available,
        sourceShardId: subject.sourceShardId,
        targetShardIds: [...subject.targetShardIds],
        moveCount: subject.moveCount,
        sourceTriggerFiredAt:
          options.sourceTriggerFiredAt !== undefined
            ? options.sourceTriggerFiredAt
            : (this.triggerOf(seedId, subject.sourceShardId, now)?.firedAt ?? null),
        quarantinedShardIds: [],
        cooldownLeftSlots: null,
        movedShardIds: this.anomaly.placementMovedShardsSince(
          connectionId,
          now - PLACEMENT_EPOCH_WINDOW_MS,
        ),
      },
      now,
    );
    const unreadable = invalid ? [...facts.unreadable, 'the placement policy'] : facts.unreadable;
    return placementGate({ ...facts, unreadable }, settings, now, purpose);
  }

  private cachedGates(
    connectionId: string,
    plans: readonly RebalancePlan[],
  ): Promise<PlacementGateResult[]> {
    const now = Date.now();
    const known = (plan: RebalancePlan): Promise<PlacementGateResult> | null => {
      const key = this.gateKeyFor(connectionId, plan);
      const cacheKey = `${connectionId}\u0000${plan.sourceShardId}`;
      const cached = this.gateCache.get(cacheKey);
      if (cached && cached.key === key && now - cached.at < GATE_CACHE_MS) {
        return Promise.resolve(cached.gate);
      }
      const reading = this.gateReads.get(cacheKey);
      return reading && reading.key === key ? reading.read : null;
    };
    const gates = plans.map(known);
    const missing = plans.filter((_, index) => gates[index] === null);
    if (missing.length === 0) return Promise.all(gates as Promise<PlacementGateResult>[]);
    const cluster = readPlacementCluster(
      this.anomaly,
      connectionId,
      missing.flatMap((plan) => [plan.sourceShardId, ...targetsOf(plan.moves)]),
    );
    return Promise.all(
      plans.map((plan, index) => gates[index] ?? this.gateFromCluster(connectionId, plan, cluster)),
    );
  }

  private gateFromCluster(
    connectionId: string,
    plan: RebalancePlan,
    cluster: Promise<PlacementClusterRead>,
  ): Promise<PlacementGateResult> {
    const key = this.gateKeyFor(connectionId, plan);
    const cacheKey = `${connectionId}\u0000${plan.sourceShardId}`;
    const subject = {
      sourceShardId: plan.sourceShardId,
      targetShardIds: targetsOf(plan.moves),
      moveCount: plan.moves.length,
    };
    const read = cluster
      .then((shared) => this.judgeGate(connectionId, subject, 'approve', shared))
      .then((gate) => {
        this.gateCache.set(cacheKey, { at: Date.now(), key, gate });
        return gate;
      })
      .catch((): PlacementGateResult => {
        this.gateCache.delete(cacheKey);
        return unreadableGate();
      })
      .finally(() => {
        if (this.gateReads.get(cacheKey)?.read === read) this.gateReads.delete(cacheKey);
      });
    this.gateReads.set(cacheKey, { key, read });
    return read;
  }

  private gateKeyFor(connectionId: string, plan: RebalancePlan): string {
    const seedId = this.registry.getConfig(connectionId)?.membership?.seedId ?? connectionId;
    return `${this.policyGeneration.get(seedId) ?? 0}\u0000${gateKeyOf(plan)}`;
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
    for (const seedId of this.triggers.seeds()) {
      if (!this.registry.getConfig(seedId)) this.triggers.forget(seedId);
    }
    for (const connectionId of this.epochs.seeds()) {
      if (!this.registry.getConfig(connectionId)) this.epochs.forget(connectionId);
    }
    for (const cache of [this.gateCache, this.gateReads]) {
      for (const cacheKey of cache.keys()) {
        if (!this.registry.getConfig(cacheKey.split('\u0000')[0])) cache.delete(cacheKey);
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

function targetsOf(moves: readonly { targetShardId: string }[]): string[] {
  return [...new Set(moves.map((move) => move.targetShardId))];
}

function unreadableGate(): PlacementGateResult {
  return {
    allowed: false,
    blockers: [{ kind: 'unknown', scope: 'cluster', detail: 'Could not run the safety checks.' }],
    warnings: [],
  };
}

function gateKeyOf(plan: RebalancePlan): string {
  return JSON.stringify(plan.moves.map((move) => [move.targetShardId, move.ranges]));
}

function effectiveModeOf(mode: PlacementMode, support: PlacementSupport): PlacementMode {
  const ladder = PLACEMENT_MODES.slice(0, PLACEMENT_MODES.indexOf(mode) + 1).reverse();
  return ladder.find((each) => support.modes[each].available) ?? 'observe';
}
