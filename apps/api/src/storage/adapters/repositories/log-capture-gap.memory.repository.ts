import type { LogCaptureGap, LogCaptureGapQuery } from '@betterdb/shared';
import {
  clampGapListLimit,
  type LogCaptureGapAggregate,
  type LogCaptureGapRepository,
} from '../../../common/interfaces/log-capture-gap-repository.interface';

export class LogCaptureGapMemoryRepository implements LogCaptureGapRepository {
  private gaps: LogCaptureGap[] = [];

  clear(): void {
    this.gaps = [];
  }

  async insert(gap: LogCaptureGap): Promise<void> {
    this.gaps.push({ ...gap });
  }

  async list(query: LogCaptureGapQuery): Promise<LogCaptureGap[]> {
    return this.gaps
      .filter((gap) => {
        if (gap.connectionId !== query.connectionId) return false;
        if (query.logType !== undefined && gap.logType !== query.logType) return false;
        if (query.since !== undefined && gap.detectedAt < query.since) return false;
        if (query.until !== undefined && gap.detectedAt > query.until) return false;
        return true;
      })
      .sort((a, b) => {
        if (b.detectedAt !== a.detectedAt) return b.detectedAt - a.detectedAt;
        return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
      })
      .slice(0, clampGapListLimit(query.limit))
      .map((gap) => ({ ...gap }));
  }

  async summarize(connectionId: string, since: number): Promise<LogCaptureGapAggregate[]> {
    const groups = new Map<string, LogCaptureGapAggregate>();
    for (const gap of this.gaps) {
      if (gap.connectionId !== connectionId || gap.detectedAt < since) continue;
      const key = `${gap.logType}|${gap.cause}`;
      const arrivals = gap.missingCount + gap.capturedCount;
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, {
          logType: gap.logType,
          cause: gap.cause,
          gapCount: 1,
          missingCount: gap.missingCount,
          peakArrivals: arrivals,
          lastGapAt: gap.detectedAt,
        });
      } else {
        group.gapCount += 1;
        group.missingCount += gap.missingCount;
        group.peakArrivals = Math.max(group.peakArrivals, arrivals);
        group.lastGapAt = Math.max(group.lastGapAt, gap.detectedAt);
      }
    }
    return [...groups.values()];
  }

  async prune(olderThan: number, connectionId?: string): Promise<number> {
    const before = this.gaps.length;
    this.gaps = this.gaps.filter((gap) => {
      if (connectionId !== undefined && gap.connectionId !== connectionId) return true;
      return gap.detectedAt >= olderThan;
    });
    return before - this.gaps.length;
  }
}
