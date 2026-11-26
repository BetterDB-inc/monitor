import { Injectable } from '@nestjs/common';
import { NodeSlotStats, ShardLoadSample, ShardLoadTracker, SlotLoadRate } from './shard-load';

@Injectable()
export class ShardLoadService {
  private readonly trackers = new Map<string, ShardLoadTracker>();
  private readonly latest = new Map<string, ShardLoadSample>();
  private readonly usage = new Map<string, boolean>();

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
    this.usage.set(connectionId, tracker.tracking);
    if (sample) this.latest.set(connectionId, sample);
    else if (!tracker.tracking) this.latest.delete(connectionId);
    return sample;
  }

  getLatest(connectionId: string): ShardLoadSample | null {
    return this.latest.get(connectionId) ?? null;
  }

  reportsUsage(connectionId: string): boolean | null {
    return this.usage.get(connectionId) ?? null;
  }

  getTopSlots(connectionId: string, nodeId: string, limit: number): SlotLoadRate[] {
    return this.trackers.get(connectionId)?.topSlots(nodeId, limit) ?? [];
  }

  getSlots(connectionId: string, nodeId: string): SlotLoadRate[] {
    return this.trackers.get(connectionId)?.slotsOf(nodeId) ?? [];
  }

  getMedianKeyCount(connectionId: string): number | null {
    return this.trackers.get(connectionId)?.medianKeyCount() ?? null;
  }

  forget(connectionId: string): void {
    this.trackers.delete(connectionId);
    this.latest.delete(connectionId);
    this.usage.delete(connectionId);
  }
}
