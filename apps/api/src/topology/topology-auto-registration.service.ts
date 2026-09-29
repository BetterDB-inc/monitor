import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DatabaseConnectionConfig, TopologyKind } from '@betterdb/shared';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { isTrueFlag } from '../config/env-normalize';
import { ConnectionContext, MultiConnectionPoller } from '../common/services/multi-connection-poller';
import { MS_PER_DAY, RetentionPolicyService } from '../retention/retention-policy.service';
import { TOPOLOGY_SOURCES, TopologyDiscovery, TopologySource } from './topology-source';
import {
  AddressOwner,
  MembershipDiff,
  diffMembership,
  exceedsRetirementThreshold,
  retirementKey,
} from './membership-diff';

const DISCOVERY_TIMEOUT_MS = 10_000;

@Injectable()
export class TopologyAutoRegistrationService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(TopologyAutoRegistrationService.name);
  private readonly heldRetirements = new Map<string, string>();
  private readonly loggedOnce = new Set<string>();
  private readonly pendingDiscovery = new Set<string>();
  private reconcileChain: Promise<void> = Promise.resolve();

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject(TOPOLOGY_SOURCES) private readonly sources: TopologySource[],
    private readonly configService: ConfigService,
    @Optional() private readonly retentionPolicy?: RetentionPolicyService,
  ) {
    super(connectionRegistry);
  }

  onModuleInit(): void {
    this.start();
  }

  protected getIntervalMs(): number {
    return 30_000;
  }

  protected shouldPollDisconnected(): boolean {
    return true;
  }

  protected skipUnchangedSamples(): boolean {
    return false;
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.heldRetirements.delete(connectionId);
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    await this.reconcile(ctx.connectionId);
  }

  async reconcile(seedId: string): Promise<void> {
    const run = this.reconcileChain.then(() => this.reconcileOne(seedId));
    this.reconcileChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async reconcileOne(seedId: string): Promise<void> {
    await this.connectionRegistry.withSeedLock(seedId, async () => {
      const seed = this.connectionRegistry.getConfig(seedId);
      if (!seed || !this.isSeedCandidate(seed)) return;

      const members = this.connectionRegistry.listMembers(seedId);
      await this.purgeExpired(members);

      const kind = this.kindOf(seed, members);
      if (!kind) return;

      if (!this.isEnabled(seed, kind)) {
        const active = members.filter((m) => m.membership?.origin === 'auto' && m.membership.retiredAt === undefined);
        await this.applyEach(active.map((m) => m.id), (id) => this.connectionRegistry.retireChild(id), 'retire');
        this.heldRetirements.delete(seedId);
        return;
      }

      const source = this.sourceFor(seed);
      if (!source) return;
      const discovery = await this.discover(seed, source);
      if (!discovery) return;

      const unknown = new Set(discovery.unknownGroups);
      const current = members.flatMap((m) =>
        m.membership && !(m.membership.group !== undefined && unknown.has(m.membership.group))
          ? [{ id: m.id, host: m.host, port: m.port, membership: m.membership }]
          : [],
      );
      const diff = diffMembership(seedId, discovery.nodes, current, (host, port) => this.lookup(host, port));
      await this.apply(seed, diff, members);
    });
  }

  private isSeedCandidate(seed: DatabaseConnectionConfig): boolean {
    if (seed.membership || seed.connectionType === 'external' || seed.host === 'agent') return false;
    if (seed.credentialStatus === 'decryption_failed') return false;
    return true;
  }

  private sourceFor(config: DatabaseConnectionConfig): TopologySource | null {
    let caps;
    try {
      const client = this.connectionRegistry.get(config.id);
      if (!client.isConnected()) return null;
      caps = client.getCapabilities();
    } catch {
      return null;
    }
    return this.sources.find((s) => s.handles(caps)) ?? null;
  }

  private kindOf(config: DatabaseConnectionConfig, members: DatabaseConnectionConfig[]): TopologyKind | null {
    return this.sourceFor(config)?.kind ?? members.find((m) => m.membership)?.membership?.source ?? null;
  }

  private isEnabled(config: DatabaseConnectionConfig, kind: TopologyKind): boolean {
    const source = this.sources.find((s) => s.kind === kind);
    return config.autoRegisterNodes ?? (source ? isTrueFlag(this.configService.get<string>(source.envFlag)) : false);
  }

  private async discover(seed: DatabaseConnectionConfig, source: TopologySource): Promise<TopologyDiscovery | null> {
    if (seed.sshTunnel?.enabled) {
      this.logOnce(`ssh:${seed.id}`, `Skipping auto-registration for ${seed.name}: SSH-tunnelled seeds are not supported`);
      return null;
    }
    if (this.pendingDiscovery.has(seed.id)) {
      this.logger.debug(`Skipping discovery for ${seed.name}: the previous discovery has not returned yet`);
      return null;
    }
    this.pendingDiscovery.add(seed.id);
    const settled = (): void => {
      this.pendingDiscovery.delete(seed.id);
    };
    const call = source.discover(seed, DISCOVERY_TIMEOUT_MS);
    call.then(settled, settled);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${DISCOVERY_TIMEOUT_MS}ms`)), DISCOVERY_TIMEOUT_MS);
    });
    try {
      return await Promise.race([call, timeout]);
    } catch (error) {
      this.logger.warn(`${source.kind} discovery failed for ${seed.name}; leaving members unchanged: ${error instanceof Error ? error.message : error}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private lookup(host: string, port: number): AddressOwner | null {
    const config = this.connectionRegistry.findConfigByHostPort(host, port);
    if (!config) return null;
    return {
      id: config.id,
      connectionType: config.connectionType === 'external' ? 'external' : 'direct',
      membership: config.membership,
      isSeed: config.autoRegisterNodes === true || this.connectionRegistry.listMembers(config.id).length > 0,
    };
  }

  private async apply(seed: DatabaseConnectionConfig, diff: MembershipDiff, members: DatabaseConnectionConfig[]): Promise<void> {
    for (const skip of diff.skipped) {
      this.logOnce(`skip:${seed.id}:${skip.host}:${skip.port}:${skip.reason}`, `Not registering ${skip.host}:${skip.port} under ${seed.name}: ${skip.reason}`);
    }
    await this.applyEach(diff.add, (node) => this.connectionRegistry.addManagedChild(seed.id, node).then(() => undefined), 'add');
    await this.applyEach(diff.adopt, (a) => this.connectionRegistry.adoptChild(a.id, seed.id, a.node), 'adopt');
    await this.applyEach(diff.reactivate, (r) => this.connectionRegistry.reactivateChild(r.id, r.node), 'reactivate');
    await this.applyEach(diff.refresh, (r) => this.connectionRegistry.refreshChild(r.id, r.node), 'refresh');

    const retire = this.gateRetirements(seed, diff.retire, members);
    await this.applyEach(retire, (id) => this.connectionRegistry.retireChild(id), 'retire');
  }

  private gateRetirements(seed: DatabaseConnectionConfig, retire: string[], members: DatabaseConnectionConfig[]): string[] {
    const activeAuto = members.filter((m) => m.membership?.origin === 'auto' && m.membership.retiredAt === undefined);
    const retiringAuto = retire.filter((id) => activeAuto.some((m) => m.id === id));
    if (!exceedsRetirementThreshold(retiringAuto.length, activeAuto.length)) {
      this.heldRetirements.delete(seed.id);
      return retire;
    }
    const key = retirementKey(retire);
    if (this.heldRetirements.get(seed.id) === key) {
      this.heldRetirements.delete(seed.id);
      return retire;
    }
    this.heldRetirements.set(seed.id, key);
    this.logger.warn(`Holding retirement of ${retire.length} nodes under ${seed.name} until the next discovery confirms it`);
    return [];
  }

  private async purgeExpired(members: DatabaseConnectionConfig[]): Promise<void> {
    const days = this.retentionPolicy?.getRetentionDays() ?? null;
    if (days === null) return;
    const cutoff = Date.now() - days * MS_PER_DAY;
    const expired = members.filter((m) => m.membership?.origin === 'auto' && m.membership.retiredAt !== undefined && m.membership.retiredAt < cutoff);
    await this.applyEach(expired.map((m) => m.id), (id) => this.connectionRegistry.removeChild(id), 'purge');
  }

  private async applyEach<T>(items: T[], op: (item: T) => Promise<void>, label: string): Promise<void> {
    for (const item of items) {
      try {
        await op(item);
        this.logger.log(`Topology membership ${label}: ${JSON.stringify(item)}`);
      } catch (error) {
        this.logger.warn(`Topology membership ${label} failed for ${JSON.stringify(item)}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private logOnce(key: string, message: string): void {
    if (this.loggedOnce.has(key)) return;
    this.loggedOnce.add(key);
    this.logger.log(message);
  }
}
