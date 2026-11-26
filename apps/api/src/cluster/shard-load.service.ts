import { Injectable } from '@nestjs/common';
import { NodeSlotStats, ShardLoadSample, ShardLoadTracker, SlotLoadRate } from './shard-load';
import { SustainHistory } from './sustain-history';

@Injectable()
export class ShardLoadService {
  private readonly trackers = new Map<string, ShardLoadTracker>();
  private readonly latest = new Map<string, ShardLoadSample>();
  private readonly usage = new Map<string, boolean>();
  private readonly histories = new Map<string, SustainHistory>();
  private readonly sustainMinutes = new Map<string, number>();

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
    }
    const sample = tracker.observe(nodes, timestamp);
    this.usage.set(connectionId, tracker.tracking);
    if (sample) {
      this.latest.set(connectionId, sample);
      this.historyOf(connectionId).record(sample);
    } else if (!tracker.tracking) {
      this.latest.delete(connectionId);
      this.histories.get(connectionId)?.clear();
    }
    return sample;
  }

  setSustainMinutes(connectionId: string, minutes: number): void {
    this.sustainMinutes.set(connectionId, minutes);
    this.trackers.get(connectionId)?.setSustainMinutes(minutes);
    this.histories.get(connectionId)?.setSustainMinutes(minutes);
  }

  sustainHistory(connectionId: string): SustainHistory | undefined {
    return this.histories.get(connectionId);
  }

  sustainWarmSince(connectionId: string, slot: number): number | null {
    return this.trackers.get(connectionId)?.sustainWarmSince(slot) ?? null;
  }

  private historyOf(connectionId: string): SustainHistory {
    let history = this.histories.get(connectionId);
    if (!history) {
      history = new SustainHistory();
      const minutes = this.sustainMinutes.get(connectionId);
      if (minutes !== undefined) history.setSustainMinutes(minutes);
      this.histories.set(connectionId, history);
    }
    return history;
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
    this.histories.delete(connectionId);
    this.sustainMinutes.delete(connectionId);
  }
}
