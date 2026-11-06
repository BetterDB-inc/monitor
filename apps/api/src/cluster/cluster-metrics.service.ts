import { Injectable, Logger } from '@nestjs/common';
import Valkey from 'iovalkey';
import { ClusterDiscoveryService, DiscoveredNode } from './cluster-discovery.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { MetricsParser } from '../database/parsers/metrics.parser';
import { InfoParser } from '../database/parsers/info.parser';
import {
  SlowLogEntry,
  ClientInfo,
  CommandLogEntry,
  CommandLogType,
  SlotStats,
} from '../common/types/metrics.types';
import { CLUSTER_TOTAL_SLOTS } from '../common/constants/cluster.constants';
import { withTimeout } from '../common/utils/with-timeout';
import { parseCommandStatsSection } from '../metrics/commandstats-parser';
import { isAmbiguousCommand, isReadCommand, isWriteCommand, sumWriteCalls } from './write-commands';
import { isReplicaRole } from '../database/parsers/replication-info.parser';
import { parseNodeAddress } from '../topology/membership-diff';

const MAX_KEYS_TO_CHECK_IN_SLOT = 10000;

export type SlotStatsOrder = 'key-count' | 'cpu-usec';

/** How long one node may take to answer a fan-out command before it is left out. */
export const NODE_COMMAND_TIMEOUT_MS = 5_000;
// After a primary's announced address could not be reached, slot stats skip it
// for this long and go straight to the fallback, instead of waiting out the
// connect timeout on every call (an SSH tunnel or NAT never reaches it).
const UNREACHABLE_NODE_BACKOFF_MS = 30_000;
// Part of a slot-stats budget kept back for the fallback to the connection's
// own node, so it still fits when every primary used its full timeout.
const SLOT_STATS_FALLBACK_RESERVE_MS = 1_000;

/** How many SLOTSRANGE reads one node may have in flight at once. */
const SLOT_RANGE_BATCH_SIZE = 16;

export interface ClusterSlotStatsResult {
  stats: SlotStats;
  /**
   * Slot-owning primaries that were unhealthy or did not answer for all their
   * ranges; the slots in `failedSlotRanges` are missing from `stats`.
   */
  failedNodes: string[];
  /** The slot ranges that could not be read, as discovery sees them. */
  failedSlotRanges: number[][];
}

export function inSlotRanges(slot: number, ranges: number[][]): boolean {
  return ranges.some(([start, end]) => slot >= start && slot <= (end ?? start));
}

/** Keep only the slots inside the node's owned ranges, as discovery sees them. */
export function ownedSlotStats(stats: SlotStats, ranges: number[][]): SlotStats {
  return Object.fromEntries(Object.entries(stats).filter(([slot]) => inSlotRanges(Number(slot), ranges)));
}

/**
 * Merge per-node CLUSTER SLOT-STATS replies and keep the overall top `limit` by
 * the requested metric. Each node's reply is expected to be filtered to the
 * slots it owns; a slot reported twice keeps its first entry.
 */
export function mergeSlotStats(perNode: SlotStats[], orderBy: SlotStatsOrder, limit: number): SlotStats {
  const metric = orderBy === 'cpu-usec' ? 'cpu_usec' : 'key_count';
  const bySlot = new Map<string, SlotStats[string]>();
  for (const stats of perNode) {
    for (const [slot, value] of Object.entries(stats)) {
      if (!bySlot.has(slot)) bySlot.set(slot, value);
    }
  }
  const all = [...bySlot.entries()];
  all.sort(([, a], [, b]) => (b[metric] ?? 0) - (a[metric] ?? 0));
  return Object.fromEntries(all.slice(0, limit));
}

export interface ClusterSlowlogEntry extends SlowLogEntry {
  nodeId: string;
  nodeAddress: string;
}

export interface ClusterClientEntry extends ClientInfo {
  nodeId: string;
  nodeAddress: string;
}

export interface ClusterCommandlogEntry extends CommandLogEntry {
  nodeId: string;
  nodeAddress: string;
}

export interface NodeStats {
  nodeId: string;
  nodeAddress: string;
  /** The cluster's view of the node, from CLUSTER NODES via discovery. */
  role: 'master' | 'replica';
  /**
   * The node's own view, from its `INFO replication`. Disagreement with `role`
   * after a failover is the window in which writes are accepted and then lost.
   * Absent when the node reports no role at all.
   */
  selfReportedRole?: 'master' | 'replica';
  memoryUsed: number;
  memoryPeak: number;
  memoryFragmentationRatio: number;
  opsPerSec: number;
  connectedClients: number;
  blockedClients: number;
  inputKbps: number;
  outputKbps: number;
  replicationOffset?: number;
  masterLinkStatus?: string;
  masterLastIoSecondsAgo?: number;
  cpuSys?: number;
  cpuUser?: number;
  uptimeSeconds?: number;
  /**
   * Cumulative calls across every write command the node has served, from
   * `INFO commandstats`. Only populated when the caller asks for it — it costs
   * a second INFO round trip per node — and absent when the node does not
   * expose the section.
   */
  writeCommandCalls?: number;
}

export interface NodeStatsOptions {
  /**
   * Fetch `INFO commandstats` per node as well. Off by default: the section is
   * one extra round trip per node and only the demoted-writes detector needs
   * the read/write split.
   */
  includeCommandStats?: boolean;
  /**
   * Restrict the fan-out to these node IDs. A caller watching one node should
   * not pay an `INFO` round trip per node in the cluster to observe it.
   */
  nodeIds?: ReadonlyArray<string>;
}

export interface SlotMigration {
  slot: number;
  sourceNodeId: string;
  sourceAddress: string;
  targetNodeId: string;
  targetAddress: string;
  state: 'migrating' | 'importing';
  keysRemaining?: number;
  /** Atomic slot migration (Valkey 9+): the ranges the job moves, e.g. "0-1365 5462-6826". */
  slotRange?: string;
  /** Atomic slot migration job state as Valkey reports it, e.g. "snapshotting". */
  phase?: string;
}

const FINISHED_MIGRATION_STATES = new Set(['success', 'failed', 'cancelled']);

/** One CLUSTER GETSLOTMIGRATIONS job; RESP2 delivers each map as a flat name/value array. */
export function parseSlotMigrationJobs(raw: unknown): Record<string, string>[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((job) => {
    const fields: Record<string, string> = {};
    if (Array.isArray(job)) {
      for (let i = 0; i + 1 < job.length; i += 2) fields[String(job[i])] = String(job[i + 1]);
    } else if (job && typeof job === 'object') {
      for (const [k, v] of Object.entries(job)) fields[k] = String(v);
    }
    return fields;
  });
}

@Injectable()
export class ClusterMetricsService {
  private readonly logger = new Logger(ClusterMetricsService.name);
  private loggedErrors: Set<string> = new Set();
  private readonly commandVerdicts: Map<string, boolean> = new Map();
  private readonly MAX_LOGGED_ERRORS = 500;
  // Commands a fan-out gave up waiting for, by node socket. While they stay
  // queued on that socket the node is reported as not answering instead of
  // stacking another batch behind them on every scrape. Evicting the socket
  // rejects them, so the guard only outlives a fan-out that never got a client.
  private readonly stalledNodes: Map<string, Promise<void>> = new Map();
  // Node socket key -> until when its announced address counts as unreachable.
  private readonly unreachableUntil: Map<string, number> = new Map();

  constructor(
    private readonly discoveryService: ClusterDiscoveryService,
    private readonly connectionRegistry: ConnectionRegistry,
  ) {}

  private addLoggedError(errorKey: string): void {
    // Prevent unbounded growth
    if (this.loggedErrors.size >= this.MAX_LOGGED_ERRORS) {
      this.loggedErrors.clear();
    }
    this.loggedErrors.add(errorKey);
  }

  private stalledNodeKey(node: DiscoveredNode, connectionId?: string): string {
    return `${connectionId || this.connectionRegistry.getDefaultId() || ''}:${node.id}`;
  }

  private assertNodeNotStalled(node: DiscoveredNode, key: string): void {
    if (this.stalledNodes.has(key)) {
      throw new Error(`${node.address} has not answered earlier commands yet`);
    }
  }

  /**
   * Give up on a node's outstanding commands. With the client in hand, drop and
   * disconnect it so they reject now and the next call reconnects; without one,
   * keep the node out until the work settles on its own.
   */
  private markNodeStalled(key: string, work: Promise<unknown>, client?: Valkey): void {
    if (client) {
      this.discoveryService.evictNodeClient(client);
      return;
    }
    const settled: Promise<void> = work.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (this.stalledNodes.get(key) === settled) this.stalledNodes.delete(key);
    });
    this.stalledNodes.set(key, settled);
  }

  private clearNodeError(nodeId: string, operation: string): void {
    this.loggedErrors.delete(`${operation}-${nodeId}`);
  }

  async getClusterSlowlog(
    limit: number = 100,
    connectionId?: string,
  ): Promise<ClusterSlowlogEntry[]> {
    const nodes = await this.discoveryService.discoverNodes(connectionId);
    const slowlogPromises = nodes.map((node) => this.getNodeSlowlog(node, limit, connectionId));

    const results = await Promise.allSettled(slowlogPromises);

    const allEntries: ClusterSlowlogEntry[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allEntries.push(...result.value);
      } else {
        this.logger.warn(`Failed to fetch slowlog from a node: ${result.reason}`);
      }
    }

    allEntries.sort((a, b) => b.timestamp - a.timestamp);

    return allEntries.slice(0, limit);
  }

  private async getNodeSlowlog(
    node: DiscoveredNode,
    limit: number,
    connectionId?: string,
  ): Promise<ClusterSlowlogEntry[]> {
    try {
      const client = await this.discoveryService.getNodeConnection(node.id, connectionId);
      const rawLog = await client.slowlog('GET', limit);
      const entries = MetricsParser.parseSlowLog(rawLog as unknown[]);

      // Clear error on success
      this.clearNodeError(node.id, 'slowlog');

      return entries.map((entry) => ({
        ...entry,
        nodeId: node.id,
        nodeAddress: node.address,
      }));
    } catch (error) {
      // Only log each unique error once to avoid spam
      const errorKey = `slowlog-${node.id}`;
      if (!this.loggedErrors.has(errorKey)) {
        this.logger.debug(
          `Failed to get slowlog from node ${node.id}: ${error instanceof Error ? error.message : error}`,
        );
        this.addLoggedError(errorKey);
      }
      return [];
    }
  }

  async getClusterClients(): Promise<ClusterClientEntry[]> {
    const nodes = await this.discoveryService.discoverNodes();
    const clientsPromises = nodes.map((node) => this.getNodeClients(node));

    const results = await Promise.allSettled(clientsPromises);

    const allClients: ClusterClientEntry[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allClients.push(...result.value);
      } else {
        this.logger.warn(`Failed to fetch clients from a node: ${result.reason}`);
      }
    }

    return allClients;
  }

  private async getNodeClients(node: DiscoveredNode): Promise<ClusterClientEntry[]> {
    try {
      const client = await this.discoveryService.getNodeConnection(node.id);
      const clientListString = (await client.call('CLIENT', 'LIST')) as string;
      const clients = MetricsParser.parseClientList(clientListString);

      return clients.map((client) => ({
        ...client,
        nodeId: node.id,
        nodeAddress: node.address,
      }));
    } catch (error) {
      this.logger.error(
        `Failed to get clients from node ${node.id}: ${error instanceof Error ? error.message : error}`,
      );
      return [];
    }
  }

  async getClusterCommandlog(
    type: CommandLogType,
    limit: number = 100,
  ): Promise<ClusterCommandlogEntry[]> {
    const nodes = await this.discoveryService.discoverNodes();
    const commandlogPromises = nodes.map((node) => this.getNodeCommandlog(node, type, limit));

    const results = await Promise.allSettled(commandlogPromises);

    const allEntries: ClusterCommandlogEntry[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allEntries.push(...result.value);
      } else {
        this.logger.warn(`Failed to fetch commandlog from a node: ${result.reason}`);
      }
    }

    allEntries.sort((a, b) => b.timestamp - a.timestamp);

    return allEntries.slice(0, limit);
  }

  private async getNodeCommandlog(
    node: DiscoveredNode,
    type: CommandLogType,
    limit: number,
  ): Promise<ClusterCommandlogEntry[]> {
    try {
      const client = await this.discoveryService.getNodeConnection(node.id);
      const rawLog = (await client.call('COMMANDLOG', 'GET', limit, type)) as unknown[];
      const entries = MetricsParser.parseCommandLog(rawLog);

      return entries.map((entry) => ({
        ...entry,
        nodeId: node.id,
        nodeAddress: node.address,
      }));
    } catch (error) {
      // Silently fail for nodes that don't support commandlog
      if (error instanceof Error && error.message.includes('unknown command')) {
        return [];
      }
      this.logger.error(
        `Failed to get commandlog from node ${node.id}: ${error instanceof Error ? error.message : error}`,
      );
      return [];
    }
  }

  async getClusterNodeStats(
    connectionId?: string,
    options?: NodeStatsOptions,
  ): Promise<NodeStats[]> {
    const nodes = await this.discoveryService.discoverNodes(connectionId);
    const wanted = selectNodes(nodes, options?.nodeIds);
    const statsPromises = wanted.map((node) => this.getNodeStats(node, connectionId, options));

    const results = await Promise.allSettled(statsPromises);

    const allStats: NodeStats[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        allStats.push(result.value);
      }
      // Errors already logged at DEBUG level in getNodeStats, no need to log again
    }

    return allStats;
  }

  private async getNodeStats(
    node: DiscoveredNode,
    connectionId?: string,
    options?: NodeStatsOptions,
  ): Promise<NodeStats | null> {
    try {
      const client = await this.discoveryService.getNodeConnection(node.id, connectionId);
      const infoString = await client.info();
      const info = InfoParser.parse(infoString);

      const memoryUsed = this.parseInfoValue(info, 'memory.used_memory', 0);
      const memoryPeak = this.parseInfoValue(info, 'memory.used_memory_peak', 0);
      const memoryFragmentationRatio = this.parseInfoValue(
        info,
        'memory.mem_fragmentation_ratio',
        1,
      );

      const opsPerSec = this.parseInfoValue(info, 'stats.instantaneous_ops_per_sec', 0);
      const inputKbps = this.parseInfoValue(info, 'stats.instantaneous_input_kbps', 0);
      const outputKbps = this.parseInfoValue(info, 'stats.instantaneous_output_kbps', 0);

      const connectedClients = this.parseInfoValue(info, 'clients.connected_clients', 0);
      const blockedClients = this.parseInfoValue(info, 'clients.blocked_clients', 0);

      const replicationOffset = this.getReplicationOffset(info, node.role);
      const masterLinkStatus = this.getInfoString(info, 'replication.master_link_status');
      const masterLastIoSecondsAgo = this.parseInfoValue(
        info,
        'replication.master_last_io_seconds_ago',
      );

      const cpuSys = this.parseInfoValue(info, 'cpu.used_cpu_sys');
      const cpuUser = this.parseInfoValue(info, 'cpu.used_cpu_user');

      const uptimeSeconds = this.parseInfoValue(info, 'server.uptime_in_seconds');

      const selfReportedRole = this.getSelfReportedRole(info);
      const writeCommandCalls =
        options?.includeCommandStats === true
          ? await this.getWriteCommandCalls(client, node.id)
          : undefined;

      // Clear error on success
      this.clearNodeError(node.id, 'stats');

      return {
        nodeId: node.id,
        nodeAddress: node.address,
        role: node.role,
        selfReportedRole,
        memoryUsed: memoryUsed ?? 0,
        memoryPeak: memoryPeak ?? 0,
        memoryFragmentationRatio: memoryFragmentationRatio ?? 1.0,
        opsPerSec: opsPerSec ?? 0,
        connectedClients: connectedClients ?? 0,
        blockedClients: blockedClients ?? 0,
        inputKbps: inputKbps ?? 0,
        outputKbps: outputKbps ?? 0,
        replicationOffset,
        masterLinkStatus,
        masterLastIoSecondsAgo,
        cpuSys,
        cpuUser,
        uptimeSeconds,
        writeCommandCalls,
      };
    } catch (error) {
      // Only log each unique error once to avoid spam
      const errorKey = `stats-${node.id}`;
      if (!this.loggedErrors.has(errorKey)) {
        this.logger.debug(
          `Failed to get stats from node ${node.id}: ${error instanceof Error ? error.message : error}`,
        );
        this.addLoggedError(errorKey);
      }
      return null;
    }
  }

  /**
   * Cluster-wide CLUSTER SLOT-STATS. The command only covers the slots of the
   * node that answers, so asking the connection's own socket shows one shard;
   * ask every healthy slot-owning primary instead. When none of them can be
   * reached directly, fall back to the connection's own node.
   */
  async getClusterSlotStats(
    orderBy: SlotStatsOrder = 'key-count',
    limit: number = 100,
    connectionId?: string,
  ): Promise<SlotStats> {
    return (await this.getClusterSlotStatsResult(orderBy, limit, connectionId)).stats;
  }

  /**
   * Whether a connection should report cluster-wide slot stats. Only one
   * connection per cluster may, or a sum across connections counts every slot
   * once per connection:
   * - a node registered under a seed (auto-registered or adopted) stands for
   *   that node and keeps its own slots; its seed already exports them, so
   *   Prometheus skips it (see coveredBySeed);
   * - a seed with active members reports the whole cluster;
   * - any other cluster connection reports the whole cluster only when no
   *   other registered connection is one of the nodes its discovery lists.
   *   Nodes registered one by one each keep their own node's slots. A replica
   *   reports its primary's slots, so registering both counts that shard twice.
   */
  async usesClusterWideSlotStats(connectionId?: string): Promise<boolean> {
    const id = connectionId ?? this.connectionRegistry.getDefaultId() ?? undefined;
    if (!id) return true;
    if (this.connectionRegistry.getConfig(id)?.membership) return false;
    if (this.connectionRegistry.listMembers(id).some((member) => member.membership?.retiredAt === undefined)) {
      return true;
    }
    let nodes: DiscoveredNode[];
    try {
      nodes = await this.discoveryService.discoverNodes(id);
    } catch {
      return false;
    }
    const registeredElsewhere = (host: string, port: number) => {
      const owner = this.connectionRegistry.findConfigByHostPort(host, port);
      return owner !== null && owner.id !== id;
    };
    return !nodes.some((node) => {
      const parsed = parseNodeAddress(node.address);
      if (!parsed) return false;
      return (
        registeredElsewhere(parsed.host, parsed.port) ||
        (node.hostname !== undefined && registeredElsewhere(node.hostname, parsed.port))
      );
    });
  }

  /**
   * Whether a connection is an active member of a registered seed. That seed
   * reports cluster-wide slot stats, which already include this node's slots.
   */
  coveredBySeed(connectionId: string): boolean {
    const membership = this.connectionRegistry.getConfig(connectionId)?.membership;
    return (
      membership !== undefined &&
      membership.retiredAt === undefined &&
      this.connectionRegistry.getConfig(membership.seedId) !== null
    );
  }

  /** Like getClusterSlotStats, plus the primaries that did not answer. */
  async getClusterSlotStatsResult(
    orderBy: SlotStatsOrder = 'key-count',
    limit: number = 100,
    connectionId?: string,
    timeoutMs: number = NODE_COMMAND_TIMEOUT_MS,
  ): Promise<ClusterSlotStatsResult> {
    const validLimit = Math.max(1, Math.min(limit, CLUSTER_TOTAL_SLOTS));
    const owners = (await this.discoveryService.discoverNodes(connectionId)).filter(
      (node) => node.role === 'master' && node.slots.length > 0,
    );
    const primaries = owners.filter((node) => node.healthy);
    const budgetEnd = Date.now() + timeoutMs;
    const nodeTimeoutMs = timeoutMs - Math.min(SLOT_STATS_FALLBACK_RESERVE_MS, Math.floor(timeoutMs / 4));
    // A budget cut short by the caller (what is left of a Prometheus pass) can
    // expire on a healthy node; only a full timeout drops that node's socket.
    const fullTimeout = timeoutMs >= NODE_COMMAND_TIMEOUT_MS;
    // Ask for each owned range rather than the node's top N: during a slot move
    // a node still reports the slot it is handing off, which would take one of
    // the N places and push an owned slot out. The merge ranks them instead.
    const results = await Promise.allSettled(
      primaries.map(async (node) => {
        const deadline = Date.now() + nodeTimeoutMs;
        const timeoutMessage = `${node.address} did not answer within ${nodeTimeoutMs}ms`;
        const stalledKey = this.stalledNodeKey(node, connectionId);
        this.assertNodeNotStalled(node, stalledKey);
        if ((this.unreachableUntil.get(stalledKey) ?? 0) > Date.now()) {
          throw new Error(`${node.address} could not be reached on a recent attempt`);
        }
        let client: Valkey;
        try {
          client = await withTimeout(
            this.discoveryService.getNodeConnection(node.id, connectionId),
            nodeTimeoutMs,
            timeoutMessage,
          );
        } catch (error) {
          // A connect cut off by a shortened budget says nothing about the node.
          const cutShort = !fullTimeout && error instanceof Error && error.message === timeoutMessage;
          if (!cutShort) this.unreachableUntil.set(stalledKey, Date.now() + UNREACHABLE_NODE_BACKOFF_MS);
          throw error;
        }
        this.unreachableUntil.delete(stalledKey);
        // Replies on one connection arrive in order, so once the deadline passes
        // the ranges still unanswered are failed; the answered ones are kept.
        const answers: (PromiseSettledResult<unknown> | undefined)[] = new Array(node.slots.length);
        const issued: Promise<void>[] = [];
        let expired: unknown;
        for (let i = 0; i < node.slots.length && expired === undefined; i += SLOT_RANGE_BATCH_SIZE) {
          const batch = node.slots.slice(i, i + SLOT_RANGE_BATCH_SIZE).map(([start, end], j) =>
            client.call('CLUSTER', 'SLOT-STATS', 'SLOTSRANGE', start, end ?? start).then(
              (value) => void (answers[i + j] = { status: 'fulfilled', value }),
              (reason: unknown) => void (answers[i + j] = { status: 'rejected', reason }),
            ),
          );
          issued.push(...batch);
          await withTimeout(Promise.all(batch), Math.max(0, deadline - Date.now()), timeoutMessage).catch((err) => {
            expired = err;
          });
        }
        if (expired !== undefined) {
          this.markNodeStalled(stalledKey, Promise.all(issued), fullTimeout ? client : undefined);
        }
        const perRange: PromiseSettledResult<unknown>[] = Array.from(
          answers,
          (answer) => answer ?? { status: 'rejected', reason: expired },
        );
        const rejected = perRange.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (rejected.length === perRange.length) throw rejected[0].reason;
        const stats = Object.assign(
          {},
          ...perRange.flatMap((r) =>
            r.status === 'fulfilled' ? [MetricsParser.parseSlotStats(r.value as unknown[])] : [],
          ),
        );
        return {
          stats: ownedSlotStats(stats, node.slots),
          failedRanges: node.slots.filter((_, i) => perRange[i].status === 'rejected'),
          reason: rejected[0]?.reason,
        };
      }),
    );

    const perNode: SlotStats[] = [];
    const unhealthy = owners.filter((node) => !node.healthy);
    const failedNodes = unhealthy.map((node) => node.address);
    const failedSlotRanges = unhealthy.flatMap((node) => node.slots);
    for (const [i, result] of results.entries()) {
      const node = primaries[i];
      // Each scrape and dashboard poll lands here, so log a failing node once
      // until it answers again.
      const errorKey = `slotstats-${connectionId ?? ''}-${node.id}`;
      const warnOnce = (message: string) => {
        if (this.loggedErrors.has(errorKey)) return;
        this.addLoggedError(errorKey);
        this.logger.warn(message);
      };
      if (result.status === 'rejected') {
        failedNodes.push(node.address);
        failedSlotRanges.push(...node.slots);
        warnOnce(`Failed to fetch slot stats from ${node.address}: ${result.reason}`);
        continue;
      }
      perNode.push(result.value.stats);
      if (result.value.failedRanges.length > 0) {
        failedNodes.push(node.address);
        failedSlotRanges.push(...result.value.failedRanges);
        warnOnce(
          `Failed to fetch slot stats for ${result.value.failedRanges.length} of ${node.slots.length} ` +
            `slot ranges from ${node.address}: ${result.value.reason}`,
        );
      } else {
        this.loggedErrors.delete(errorKey);
      }
    }
    if (primaries.length > 0 && perNode.length === 0) {
      // No primary answered on the address it announces, as behind an SSH
      // tunnel or NAT. The connection's own socket still reaches one node, so
      // report that node's slots and leave the other primaries as failed.
      // Its own error is the one to report: a NOPERM or "not supported" here
      // says more than a primary's timeout on an address it cannot reach.
      const fallbackTimeoutMs = Math.max(timeoutMs - nodeTimeoutMs, budgetEnd - Date.now());
      const stats = await withTimeout(
        this.connectionRegistry.get(connectionId).getClusterSlotStats(orderBy, validLimit),
        fallbackTimeoutMs,
        `The connection did not answer CLUSTER SLOT-STATS within ${fallbackTimeoutMs}ms`,
      );
      const self = owners.find((node) => node.flags?.includes('myself'));
      return {
        stats,
        failedNodes: failedNodes.filter((address) => address !== self?.address),
        failedSlotRanges: self ? failedSlotRanges.filter((range) => !self.slots.includes(range)) : failedSlotRanges,
      };
    }
    // Valkey leaves cpu-usec out of every reply while cluster-slot-stats-enabled
    // is off, so ranking on it would return arbitrary slots. ORDERBY cpu-usec
    // on one node rejects the same way.
    if (
      orderBy === 'cpu-usec' &&
      perNode.some((stats) => Object.keys(stats).length > 0) &&
      !perNode.some((stats) => Object.values(stats).some((slot) => slot.cpu_usec !== undefined))
    ) {
      throw new Error(
        'Unrecognized sort metric for ORDERBY: cpu-usec is only reported while cluster-slot-stats-enabled is yes.',
      );
    }
    return {
      stats: mergeSlotStats(perNode, orderBy, validLimit),
      failedNodes,
      failedSlotRanges,
    };
  }

  /**
   * Run commands against one node within `timeoutMs`, so a node that accepts
   * the connection but never replies cannot hold up a fan-out. The timeout
   * releases the caller and drops the node's client, so the command still on
   * that socket rejects and the next call reconnects.
   */
  private onNode<T>(
    node: DiscoveredNode,
    connectionId: string | undefined,
    timeoutMs: number,
    run: (client: Valkey) => Promise<T>,
  ): Promise<T> {
    const key = this.stalledNodeKey(node, connectionId);
    try {
      this.assertNodeNotStalled(node, key);
    } catch (error) {
      return Promise.reject(error);
    }
    let settled = false;
    let timedOut = false;
    let client: Valkey | undefined;
    const work = this.discoveryService
      .getNodeConnection(node.id, connectionId)
      .then((connected) => {
        // Connected only after the caller gave up: nothing waits for commands
        // sent now, and a silent node would hold them, and the guard, forever.
        if (timedOut) {
          this.discoveryService.evictNodeClient(connected);
          throw new Error(`${node.address} connected after the ${timeoutMs}ms deadline`);
        }
        return run((client = connected));
      })
      .finally(() => {
        settled = true;
      });
    return withTimeout(work, timeoutMs, `${node.address} did not answer within ${timeoutMs}ms`).catch(
      (error: unknown) => {
        if (!settled) {
          timedOut = true;
          this.markNodeStalled(key, work, client);
        }
        throw error;
      },
    );
  }

  async getNodeInfo(nodeId: string): Promise<Record<string, unknown>> {
    const client = await this.discoveryService.getNodeConnection(nodeId);
    const infoString = await client.info();
    return InfoParser.parse(infoString);
  }

  /**
   * Slot migrations in progress, asked of every primary: legacy MIGRATING /
   * IMPORTING markers only appear on a node's own CLUSTER NODES line, and atomic
   * slot migration jobs (Valkey 9+, CLUSTER MIGRATESLOTS) only show up in
   * CLUSTER GETSLOTMIGRATIONS on the source and target nodes.
   */
  async getSlotMigrations(connectionId?: string): Promise<SlotMigration[]> {
    let nodes: DiscoveredNode[];
    try {
      nodes = await this.discoveryService.discoverNodes(connectionId);
    } catch (error) {
      this.logger.error(
        `Failed to check slot migrations: ${error instanceof Error ? error.message : error}`,
      );
      return [];
    }

    const findNode = (idOrPrefix: string) =>
      idOrPrefix ? nodes.find((n) => n.id.startsWith(idOrPrefix)) : undefined;
    // The source's MIGRATING marker and the target's IMPORTING marker describe
    // the same move; keep one entry and let MIGRATING win so the label is stable.
    const legacy = new Map<string, SlotMigration>();
    const addLegacy = (migration: SlotMigration) => {
      const key = `${migration.slot}:${migration.sourceNodeId}:${migration.targetNodeId}`;
      if (!legacy.has(key) || migration.state === 'migrating') legacy.set(key, migration);
    };
    // Both ends of an atomic migration report the job; keep one per job name,
    // preferring the source's EXPORT view so the entry does not flip between polls.
    const atomicJobs = new Map<string, SlotMigration>();

    const addLegacyMarkers = (nodesString: string) => {
      for (const line of nodesString.trim().split('\n')) {
        const parts = line.split(' ');
        if (parts.length < 8) continue;
        const [nodeId, address] = parts;
        for (const slotRange of parts.slice(8)) {
          const migrating = slotRange.match(/\[(\d+)->-([a-f0-9]+)\]/i);
          const target = migrating && findNode(migrating[2]);
          if (migrating && target) {
            addLegacy({
              slot: parseInt(migrating[1], 10),
              sourceNodeId: nodeId,
              sourceAddress: address,
              targetNodeId: target.id,
              targetAddress: target.address,
              state: 'migrating',
              keysRemaining: undefined, // Can't get this without node connection
            });
          }

          const importing = slotRange.match(/\[(\d+)-<-([a-f0-9]+)\]/i);
          const source = importing && findNode(importing[2]);
          if (importing && source) {
            addLegacy({
              slot: parseInt(importing[1], 10),
              sourceNodeId: source.id,
              sourceAddress: source.address,
              targetNodeId: nodeId,
              targetAddress: address,
              state: 'importing',
            });
          }
        }
      }
    };
    let nodesRead = 0;

    const readNode = async (primary: DiscoveredNode, client: Valkey): Promise<void> => {
      try {
        addLegacyMarkers((await client.call('CLUSTER', 'NODES')) as string);
        nodesRead++;
      } catch (error) {
        this.logger.debug(`CLUSTER NODES failed on ${primary.address}: ${error}`);
      }

      let jobs: Record<string, string>[];
      try {
        jobs = parseSlotMigrationJobs(await client.call('CLUSTER', 'GETSLOTMIGRATIONS'));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Before Valkey 9 the subcommand does not exist; anything else is worth a line.
        const errorKey = `getslotmigrations-${primary.id}-${message}`;
        if (!/unknown (sub)?command/i.test(message) && !this.loggedErrors.has(errorKey)) {
          this.addLoggedError(errorKey);
          this.logger.warn(`CLUSTER GETSLOTMIGRATIONS failed on ${primary.address}: ${message}`);
        }
        return;
      }
      for (const job of jobs) {
        if (!job.name || FINISHED_MIGRATION_STATES.has(job.state)) continue;
        const isImport = job.operation?.toUpperCase() === 'IMPORT';
        if (isImport && atomicJobs.has(job.name)) continue;
        const source = findNode(job.source_node ?? '');
        const target = findNode(job.target_node ?? '');
        const firstSlot = parseInt((job.slot_ranges ?? '').split(/[-\s]/)[0], 10);
        atomicJobs.set(job.name, {
          slot: Number.isNaN(firstSlot) ? -1 : firstSlot,
          slotRange: job.slot_ranges,
          sourceNodeId: source?.id ?? job.source_node ?? '',
          sourceAddress: source?.address ?? '',
          targetNodeId: target?.id ?? job.target_node ?? '',
          targetAddress: target?.address ?? '',
          state: isImport ? 'importing' : 'migrating',
          phase: job.state,
        });
      }
    };

    // A new primary has no slots until its first import lands, so include every primary.
    const primaries = nodes.filter((node) => node.role === 'master' && node.healthy);
    await Promise.all(
      primaries.map((primary) =>
        this.onNode(primary, connectionId, NODE_COMMAND_TIMEOUT_MS, (client) => readNode(primary, client)).catch((error) => {
          this.logger.debug(`Slot migration check skipped ${primary.address}: ${error}`);
        }),
      ),
    );

    // No primary could be read directly, as behind an SSH tunnel or NAT: the
    // connection's own node still shows its own markers and migration jobs.
    if (primaries.length > 0 && nodesRead === 0) {
      const errorKey = `slotmigrations-${connectionId ?? ''}`;
      if (!this.loggedErrors.has(errorKey)) {
        this.logger.warn(
          'Slot migration check could not read any primary directly; reading the connection\'s own node instead',
        );
        this.addLoggedError(errorKey);
      }
      // Ask it the same way as a primary, so atomic migrations it is part of
      // (GETSLOTMIGRATIONS) show up as well as legacy markers.
      const self = nodes.find((node) => node.flags.includes('myself')) ?? primaries[0];
      try {
        await readNode(self, this.connectionRegistry.get(connectionId).getClient());
      } catch (error) {
        this.logger.error(
          `Failed to check slot migrations: ${error instanceof Error ? error.message : error}`,
        );
      }
    } else {
      this.loggedErrors.delete(`slotmigrations-${connectionId ?? ''}`);
    }

    return [...legacy.values(), ...atomicJobs.values()];
  }

  private async getKeysInSlot(client: Valkey, slot: number): Promise<number | undefined> {
    try {
      const keys = (await client.call(
        'CLUSTER',
        'GETKEYSINSLOT',
        slot,
        MAX_KEYS_TO_CHECK_IN_SLOT,
      )) as string[];
      return keys.length;
    } catch (error) {
      this.logger.debug(
        `Could not get keys count for slot ${slot}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return undefined;
    }
  }

  private parseInfoValue(
    info: Record<string, unknown>,
    path: string,
    defaultValue?: number,
  ): number | undefined {
    const parts = path.split('.');
    let current: unknown = info;

    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = (current as Record<string, unknown>)[part];
      } else {
        return defaultValue;
      }
    }

    if (typeof current === 'string') {
      const parsed = parseFloat(current);
      return isNaN(parsed) ? defaultValue : parsed;
    }

    if (typeof current === 'number') {
      return current;
    }

    return defaultValue;
  }

  private getInfoString(info: Record<string, unknown>, path: string): string | undefined {
    const parts = path.split('.');
    let current: unknown = info;

    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = (current as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    return typeof current === 'string' ? current : undefined;
  }

  private getSelfReportedRole(info: Record<string, unknown>): 'master' | 'replica' | undefined {
    const role = this.getInfoString(info, 'replication.role');
    if (role === 'master') {
      return 'master';
    }
    if (isReplicaRole(role)) {
      return 'replica';
    }
    return undefined;
  }

  /**
   * A second INFO call rather than `INFO default commandstats`: multi-section
   * INFO is Redis 7.0+/Valkey only, and single-section INFO is universal.
   *
   * A node that denies or lacks the section yields undefined rather than zero —
   * zero would read as "served no writes", which is a different claim. So does
   * a node with traffic this service could not classify: a module command, or a
   * core command newer than the built-in write list. The caller falls back to
   * `opsPerSec` for all of them.
   */
  private async getWriteCommandCalls(client: Valkey, nodeId: string): Promise<number | undefined> {
    try {
      const raw = await client.info('commandstats');
      const parsed = InfoParser.parse(raw);
      const section = parsed.commandstats as Record<string, string> | undefined;
      if (section === undefined) {
        return undefined;
      }
      const samples = parseCommandStatsSection(section);
      await this.resolveCommandVerdicts(
        client,
        nodeId,
        samples.map((sample) => {
          return sample.command;
        }),
      );
      const totals = sumWriteCalls(samples, (command) => {
        return this.commandVerdicts.get(command.toLowerCase());
      });
      if (totals.writes === 0 && totals.unclassified > 0) {
        return undefined;
      }
      return totals.writes;
    } catch (error) {
      const errorKey = `commandstats-${nodeId}`;
      if (!this.loggedErrors.has(errorKey)) {
        this.logger.debug(
          `Failed to get commandstats from node ${nodeId}: ${error instanceof Error ? error.message : error}`,
        );
        this.addLoggedError(errorKey);
      }
      return undefined;
    }
  }

  /**
   * Ask the server to classify the commands the built-in list does not name, so
   * a core command added after that list was written still counts as a write.
   * `COMMAND INFO` predates every supported server and accepts the
   * `parent|subcommand` form `commandstats` reports. The commands whose bucket
   * merges a read and a write form are not asked about: the server flags them
   * `write`, which is the wrong answer for the read-only form it cannot see.
   *
   * Verdicts are cached for the process: a command's flags do not change while
   * the server is running, so this costs one call per newly seen command name.
   * A name the server does not answer for stays uncached and is reported as
   * unclassified, which routes the caller to the `opsPerSec` fallback.
   */
  private async resolveCommandVerdicts(
    client: Valkey,
    nodeId: string,
    commands: ReadonlyArray<string>,
  ): Promise<void> {
    const unresolved = [
      ...new Set(
        commands.map((command) => {
          return command.toLowerCase();
        }),
      ),
    ].filter((command) => {
      if (isWriteCommand(command) || isReadCommand(command)) {
        return false;
      }
      if (isAmbiguousCommand(command)) {
        return false;
      }
      return !this.commandVerdicts.has(command);
    });

    if (unresolved.length === 0) {
      return;
    }

    try {
      const reply = (await client.call('COMMAND', 'INFO', ...unresolved)) as unknown[];
      unresolved.forEach((command, index) => {
        const entry = reply[index];
        if (!Array.isArray(entry)) {
          return;
        }
        const flags = entry[2];
        if (!Array.isArray(flags)) {
          return;
        }
        this.commandVerdicts.set(command, flags.includes('write'));
      });
    } catch (error) {
      const errorKey = `command-info-${nodeId}`;
      if (!this.loggedErrors.has(errorKey)) {
        this.logger.debug(
          `Failed to classify commands on node ${nodeId}: ${error instanceof Error ? error.message : error}`,
        );
        this.addLoggedError(errorKey);
      }
    }
  }

  private getReplicationOffset(
    info: Record<string, unknown>,
    role: 'master' | 'replica',
  ): number | undefined {
    if (role === 'master') {
      return this.parseInfoValue(info, 'replication.master_repl_offset');
    } else {
      return this.parseInfoValue(info, 'replication.slave_repl_offset');
    }
  }
}

/**
 * Narrow a discovered node list to the IDs a caller asked for.
 *
 * An empty `nodeIds` means "none", not "all" — the caller asked for a specific
 * set and it happened to be empty.
 */
function selectNodes(
  nodes: ReadonlyArray<DiscoveredNode>,
  nodeIds?: ReadonlyArray<string>,
): DiscoveredNode[] {
  if (nodeIds === undefined) {
    return [...nodes];
  }
  const wanted = new Set(nodeIds);
  return nodes.filter((node) => {
    return wanted.has(node.id);
  });
}
