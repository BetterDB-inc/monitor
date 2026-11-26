import { Injectable, Logger } from '@nestjs/common';
import { NodeSlotStats, ShardLoadSample, ShardLoadTracker, SlotLoadRate } from './shard-load';

export interface ShardLoadListener {
  tracking(connectionId: string): void;
  sample(connectionId: string, sample: ShardLoadSample): void;
  reset(connectionId: string): void;
}

@Injectable()
export class ShardLoadService {
  private readonly logger = new Logger(ShardLoadService.name);
  private readonly trackers = new Map<string, ShardLoadTracker>();
  private readonly latest = new Map<string, ShardLoadSample>();
  private readonly usage = new Map<string, boolean>();
  private readonly sustainMinutes = new Map<string, number>();
  private readonly listeners = new Set<ShardLoadListener>();

  addListener(listener: ShardLoadListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  record(
    connectionId: string,
    nodes: readonly NodeSlotStats[],
    timestamp: number,
  ): ShardLoadSample | null {
    let tracker = this.trackers.get(connectionId);
    if (!tracker) {
      tracker = new ShardLoadTracker();
      const minutes = this.sustainMinutes.get(connectionId);
      if (minutes !== undefined) tracker.setSustainMinutes(minutes);
      this.trackers.set(connectionId, tracker);
      this.notify((listener) => listener.tracking(connectionId));
    }
    const wasTracking = tracker.tracking;
    const sample = tracker.observe(nodes, timestamp);
    this.usage.set(connectionId, tracker.tracking);
    if (sample) {
      this.latest.set(connectionId, sample);
      this.notify((listener) => listener.sample(connectionId, sample));
    } else if (!tracker.tracking) {
      this.latest.delete(connectionId);
      if (wasTracking) this.notify((listener) => listener.reset(connectionId));
    }
    return sample;
  }

  setSustainMinutes(connectionId: string, minutes: number): void {
    this.sustainMinutes.set(connectionId, minutes);
    this.trackers.get(connectionId)?.setSustainMinutes(minutes);
  }

  sustainWarmSince(connectionId: string, slot: number): number | null {
    return this.trackers.get(connectionId)?.sustainWarmSince(slot) ?? null;
  }

  private notify(call: (listener: ShardLoadListener) => void): void {
    for (const listener of this.listeners) {
      try {
        call(listener);
      } catch (error) {
        this.logger.warn(
          `A shard load listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
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
    this.notify((listener) => listener.reset(connectionId));
  }

  remove(connectionId: string): void {
    this.forget(connectionId);
    this.sustainMinutes.delete(connectionId);
  }
}
