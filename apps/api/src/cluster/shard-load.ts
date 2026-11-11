import { CLUSTER_TOTAL_SLOTS } from '../common/constants/cluster.constants';
import { SlotStats } from '../common/types/metrics.types';

export const SHARD_LOAD_SMOOTHING_MS = 30_000;
export const SHARD_LOAD_SETTLE_SAMPLES = 2;

export interface NodeSlotStats {
  nodeId: string;
  address: string;
  stats: SlotStats;
}

export interface SlotLoadRate {
  slot: number;
  cpuUsecPerSecond: number;
  networkBytesInPerSecond: number;
  networkBytesOutPerSecond: number;
  keyCount: number;
}

export type SlotLoadOrder = 'cpu' | 'network';

export interface ShardLoad {
  nodeId: string;
  address: string;
  slotCount: number;
  measuredSlots: number;
  cpuUsecPerSecond: number;
  networkBytesInPerSecond: number;
  networkBytesOutPerSecond: number;
  cpuShare: number;
  networkShare: number;
}

export interface ShardLoadSample {
  timestamp: number;
  shards: ShardLoad[];
  settling: boolean;
}

function tracksUsage(nodes: readonly NodeSlotStats[]): boolean {
  return nodes.every((node) =>
    Object.values(node.stats).every(
      (slot) =>
        slot.cpu_usec !== undefined &&
        slot.network_bytes_in !== undefined &&
        slot.network_bytes_out !== undefined,
    ),
  );
}

export class ShardLoadTracker {
  private readonly lastCpu = new Float64Array(CLUSTER_TOTAL_SLOTS);
  private readonly lastBytesIn = new Float64Array(CLUSTER_TOTAL_SLOTS);
  private readonly lastBytesOut = new Float64Array(CLUSTER_TOTAL_SLOTS);
  private readonly cpuRate = new Float64Array(CLUSTER_TOTAL_SLOTS);
  private readonly bytesInRate = new Float64Array(CLUSTER_TOTAL_SLOTS);
  private readonly bytesOutRate = new Float64Array(CLUSTER_TOTAL_SLOTS);
  private readonly keyCount = new Float64Array(CLUSTER_TOTAL_SLOTS);
  private readonly seen = new Uint8Array(CLUSTER_TOTAL_SLOTS);
  private readonly measured = new Uint8Array(CLUSTER_TOTAL_SLOTS);
  private readonly present = new Uint8Array(CLUSTER_TOTAL_SLOTS);
  private readonly owner: (string | undefined)[] = new Array(CLUSTER_TOTAL_SLOTS);
  private slotsByNode = new Map<string, number[]>();
  private lastTimestamp: number | null = null;
  private settleRemaining = 0;

  get tracking(): boolean {
    return this.lastTimestamp !== null;
  }

  observe(nodes: readonly NodeSlotStats[], timestamp: number): ShardLoadSample | null {
    if (!tracksUsage(nodes)) {
      this.reset();
      return null;
    }
    const previous = this.lastTimestamp;
    if (previous !== null && timestamp <= previous) return null;

    const elapsedMs = previous === null ? 0 : timestamp - previous;
    const weight = 1 - Math.exp(-elapsedMs / SHARD_LOAD_SMOOTHING_MS);
    const slotsByNode = new Map<string, number[]>();
    let ownershipChanged = false;
    let unmeasured = false;
    this.present.fill(0);

    for (const node of nodes) {
      const slots: number[] = [];
      slotsByNode.set(node.nodeId, slots);
      for (const [key, stats] of Object.entries(node.stats)) {
        const slot = Number(key);
        if (!Number.isInteger(slot) || slot < 0 || slot >= CLUSTER_TOTAL_SLOTS) continue;
        slots.push(slot);
        this.present[slot] = 1;
        const cpu = stats.cpu_usec as number;
        const bytesIn = stats.network_bytes_in as number;
        const bytesOut = stats.network_bytes_out as number;
        const moved = this.owner[slot] !== node.nodeId;
        const wentBack =
          cpu < this.lastCpu[slot] ||
          bytesIn < this.lastBytesIn[slot] ||
          bytesOut < this.lastBytesOut[slot];
        if (moved && previous !== null) ownershipChanged = true;

        if (previous === null || !this.seen[slot] || moved || wentBack) {
          this.clearRates(slot);
          if (previous !== null) unmeasured = true;
        } else {
          const seconds = elapsedMs / 1000;
          this.cpuRate[slot] = this.smooth(
            slot,
            this.cpuRate[slot],
            (cpu - this.lastCpu[slot]) / seconds,
            weight,
          );
          this.bytesInRate[slot] = this.smooth(
            slot,
            this.bytesInRate[slot],
            (bytesIn - this.lastBytesIn[slot]) / seconds,
            weight,
          );
          this.bytesOutRate[slot] = this.smooth(
            slot,
            this.bytesOutRate[slot],
            (bytesOut - this.lastBytesOut[slot]) / seconds,
            weight,
          );
          this.measured[slot] = 1;
        }
        this.lastCpu[slot] = cpu;
        this.lastBytesIn[slot] = bytesIn;
        this.lastBytesOut[slot] = bytesOut;
        this.keyCount[slot] = stats.key_count;
        this.owner[slot] = node.nodeId;
        this.seen[slot] = 1;
      }
    }

    for (let slot = 0; slot < CLUSTER_TOTAL_SLOTS; slot++) {
      if (!this.seen[slot] || this.present[slot]) continue;
      this.seen[slot] = 0;
      this.owner[slot] = undefined;
      this.clearRates(slot);
      ownershipChanged = true;
    }

    this.slotsByNode = slotsByNode;
    this.lastTimestamp = timestamp;
    if (previous === null) return null;

    let settling = unmeasured;
    if (ownershipChanged) {
      this.settleRemaining = SHARD_LOAD_SETTLE_SAMPLES;
      settling = true;
    } else if (this.settleRemaining > 0) {
      this.settleRemaining -= 1;
      settling = true;
    }
    return { timestamp, shards: this.summarize(nodes), settling };
  }

  topSlots(nodeId: string, limit: number, by: SlotLoadOrder = 'cpu'): SlotLoadRate[] {
    const network = (rate: SlotLoadRate) =>
      rate.networkBytesInPerSecond + rate.networkBytesOutPerSecond;
    const cpu = (rate: SlotLoadRate) => rate.cpuUsecPerSecond;
    const [first, second] = by === 'cpu' ? [cpu, network] : [network, cpu];
    return (this.slotsByNode.get(nodeId) ?? [])
      .filter((slot) => this.measured[slot])
      .map((slot) => ({
        slot,
        cpuUsecPerSecond: this.cpuRate[slot],
        networkBytesInPerSecond: this.bytesInRate[slot],
        networkBytesOutPerSecond: this.bytesOutRate[slot],
        keyCount: this.keyCount[slot],
      }))
      .sort((a, b) => first(b) - first(a) || second(b) - second(a) || a.slot - b.slot)
      .slice(0, Math.max(0, limit));
  }

  private smooth(slot: number, current: number, latest: number, weight: number): number {
    return this.measured[slot] ? current + weight * (latest - current) : latest;
  }

  private clearRates(slot: number): void {
    this.measured[slot] = 0;
    this.cpuRate[slot] = 0;
    this.bytesInRate[slot] = 0;
    this.bytesOutRate[slot] = 0;
  }

  private reset(): void {
    this.seen.fill(0);
    this.measured.fill(0);
    this.owner.fill(undefined);
    this.slotsByNode = new Map();
    this.lastTimestamp = null;
    this.settleRemaining = 0;
  }

  private summarize(nodes: readonly NodeSlotStats[]): ShardLoad[] {
    const shards: ShardLoad[] = [];
    for (const node of nodes) {
      const slots = this.slotsByNode.get(node.nodeId) ?? [];
      const shard: ShardLoad = {
        nodeId: node.nodeId,
        address: node.address,
        slotCount: slots.length,
        measuredSlots: 0,
        cpuUsecPerSecond: 0,
        networkBytesInPerSecond: 0,
        networkBytesOutPerSecond: 0,
        cpuShare: 0,
        networkShare: 0,
      };
      for (const slot of slots) {
        if (!this.measured[slot]) continue;
        shard.measuredSlots += 1;
        shard.cpuUsecPerSecond += this.cpuRate[slot];
        shard.networkBytesInPerSecond += this.bytesInRate[slot];
        shard.networkBytesOutPerSecond += this.bytesOutRate[slot];
      }
      if (shard.measuredSlots > 0) shards.push(shard);
    }
    const network = (shard: ShardLoad) =>
      shard.networkBytesInPerSecond + shard.networkBytesOutPerSecond;
    const totalCpu = shards.reduce((total, shard) => total + shard.cpuUsecPerSecond, 0);
    const totalNetwork = shards.reduce((total, shard) => total + network(shard), 0);
    for (const shard of shards) {
      shard.cpuShare = totalCpu > 0 ? shard.cpuUsecPerSecond / totalCpu : 0;
      shard.networkShare = totalNetwork > 0 ? network(shard) / totalNetwork : 0;
    }
    return shards;
  }
}
