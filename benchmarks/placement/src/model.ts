import type { NodeSlotStats } from './product';

export const TOTAL_SLOTS = 16384;

export interface ModelShard {
  nodeId: string;
  address: string;
  slots: readonly [number, number];
}

export interface HotSlot {
  slot: number;
  cpuUsecPerSecond: number;
}

export interface LoadModel {
  shards: readonly ModelShard[];
  baseCpuUsecPerSlot: number;
  baseBytesPerSlot: number;
  keysPerSlot: number;
  hotSlots: readonly HotSlot[];
}

export function evenShards(count: number): ModelShard[] {
  const size = Math.floor(TOTAL_SLOTS / count);
  return Array.from({ length: count }, (_, index) => ({
    nodeId: `node${String(index + 1).padStart(36, '0')}`,
    address: `10.0.0.${index + 1}:6379`,
    slots: [index * size, index === count - 1 ? TOTAL_SLOTS - 1 : (index + 1) * size - 1] as const,
  }));
}

export function slotCpu(model: LoadModel, slot: number): number {
  const hot = model.hotSlots.find((each) => each.slot === slot);
  return hot ? hot.cpuUsecPerSecond : model.baseCpuUsecPerSlot;
}

export function ownerOf(model: LoadModel, slot: number): ModelShard {
  const shard = model.shards.find(({ slots: [start, end] }) => slot >= start && slot <= end);
  if (!shard) throw new Error(`no shard owns slot ${slot}`);
  return shard;
}

export function slotStatsAt(model: LoadModel, seconds: number): NodeSlotStats[] {
  return model.shards.map((shard) => {
    const stats: NodeSlotStats['stats'] = {};
    for (let slot = shard.slots[0]; slot <= shard.slots[1]; slot++) {
      stats[slot] = {
        key_count: model.keysPerSlot,
        cpu_usec: Math.round(slotCpu(model, slot) * seconds),
        network_bytes_in: Math.round(model.baseBytesPerSlot * seconds),
        network_bytes_out: Math.round(model.baseBytesPerSlot * seconds),
      };
    }
    return { nodeId: shard.nodeId, address: shard.address, stats };
  });
}
