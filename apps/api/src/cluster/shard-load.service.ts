import { Injectable } from '@nestjs/common';
import {
  NodeSlotStats,
  ShardLoadSample,
  ShardLoadTracker,
  SlotLoadOrder,
  SlotLoadRate,
} from './shard-load';

@Injectable()
export class ShardLoadService {
  private readonly trackers = new Map<string, ShardLoadTracker>();
  private readonly latest = new Map<string, ShardLoadSample>();

  record(
    connectionId: string,
    nodes: readonly NodeSlotStats[],
    timestamp: number,
  ): ShardLoadSample | null {
    let tracker = this.trackers.get(connectionId);
    if (!tracker) {
      tracker = new ShardLoadTracker();
      this.trackers.set(connectionId, tracker);
    }
    const sample = tracker.observe(nodes, timestamp);
    if (sample) this.latest.set(connectionId, sample);
    else if (!tracker.tracking) this.latest.delete(connectionId);
    return sample;
  }

  getLatest(connectionId: string): ShardLoadSample | null {
    return this.latest.get(connectionId) ?? null;
  }

  getTopSlots(
    connectionId: string,
    nodeId: string,
    limit: number,
    by: SlotLoadOrder = 'cpu',
  ): SlotLoadRate[] {
    return this.trackers.get(connectionId)?.topSlots(nodeId, limit, by) ?? [];
  }

  forget(connectionId: string): void {
    this.trackers.delete(connectionId);
    this.latest.delete(connectionId);
  }
}
