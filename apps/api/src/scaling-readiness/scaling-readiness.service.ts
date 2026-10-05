import { Inject, Injectable } from '@nestjs/common';
import type { MetricForecast, ScalingReadiness } from '@betterdb/shared';
import type { DatabasePort } from '../common/interfaces/database-port.interface';
import type {
  StoragePort,
  StoredMemorySnapshot,
} from '../common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { MetricForecastingService } from '../metric-forecasting/metric-forecasting.service';
import {
  connectionsInput,
  cpuInput,
  forecastInput,
  growthInput,
  memoryInput,
  SeriesPoint,
} from './dimension-inputs';
import { DimensionInput, notApplicable, scoreReadiness, WEEK_MS } from './scoring';

const CACHE_TTL_MS = 60_000;
const IO_THREADS_TTL_MS = 10 * 60_000;
const IO_THREADS_RETRY_TTL_MS = 60_000;
const CPU_SAMPLE_COUNT = 5;
const SNAPSHOT_LIMIT = 11_000;

interface ThreadInfo {
  threads: number;
  note: string | null;
}

@Injectable()
export class ScalingReadinessService {
  private readonly cache = new Map<string, ScalingReadiness>();
  private readonly threadCache = new Map<string, { value: ThreadInfo; at: number; ttl: number }>();
  private readonly inFlight = new Map<string, Promise<ScalingReadiness>>();

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly connectionRegistry: ConnectionRegistry,
    private readonly forecasting: MetricForecastingService,
  ) {}

  async compute(connectionId: string): Promise<ScalingReadiness> {
    const now = Date.now();
    const cached = this.cache.get(connectionId);
    if (cached && now - cached.computedAt < CACHE_TTL_MS) return cached;
    const pending = this.inFlight.get(connectionId);
    if (pending) return pending;
    const run = this.computeAndCache(connectionId, now).finally(() => {
      this.inFlight.delete(connectionId);
    });
    this.inFlight.set(connectionId, run);
    return run;
  }

  private async computeAndCache(connectionId: string, now: number): Promise<ScalingReadiness> {
    const result = await this.computeFresh(connectionId, now);
    for (const [id, entry] of this.cache) {
      if (now - entry.computedAt >= CACHE_TTL_MS) this.cache.delete(id);
    }
    this.cache.set(connectionId, result);
    return result;
  }

  private async computeFresh(connectionId: string, now: number): Promise<ScalingReadiness> {
    const client = this.connectionRegistry.get(connectionId);
    if (client.getCapabilities().isSentinel === true) {
      return notApplicable(connectionId, now, 'Not applicable to Sentinel');
    }
    const external = this.connectionRegistry.getConfig(connectionId)?.connectionType === 'external';
    const snapshots = [
      ...(await this.storage.getMemorySnapshots({
        connectionId,
        startTime: now - WEEK_MS,
        limit: SNAPSHOT_LIMIT,
      })),
    ].reverse();
    const latest = snapshots[snapshots.length - 1];
    const { threads, note } = await this.effectiveThreads(connectionId, client, external, now);

    return scoreReadiness(connectionId, now, {
      memory: memoryInput(latest),
      connections: connectionsInput(latest, external),
      cpu: cpuInput(snapshots.slice(-CPU_SAMPLE_COUNT), threads, note),
      opsTrend: await this.opsTrendInput(connectionId, snapshots),
      keyspaceGrowth: this.keyspaceInput(snapshots),
    });
  }

  private async opsTrendInput(
    connectionId: string,
    snapshots: StoredMemorySnapshot[],
  ): Promise<DimensionInput> {
    const forecast = await this.forecasting
      .getForecast(connectionId, 'opsPerSec')
      .catch((): MetricForecast | null => null);
    return (
      forecastInput(forecast) ??
      growthInput(
        snapshots.map((s) => ({ timestamp: s.timestamp, value: s.opsPerSec })),
        'Ops/sec',
      )
    );
  }

  private keyspaceInput(snapshots: StoredMemorySnapshot[]): DimensionInput {
    const points: SeriesPoint[] = snapshots.flatMap((s) =>
      s.totalKeys == null ? [] : [{ timestamp: s.timestamp, value: s.totalKeys }],
    );
    if (points.length === 0) return { excludedReason: 'No key counts yet' };
    return growthInput(points, 'Keys');
  }

  private async effectiveThreads(
    connectionId: string,
    client: DatabasePort,
    external: boolean,
    now: number,
  ): Promise<ThreadInfo> {
    if (external) return { threads: 1, note: null };
    const cached = this.threadCache.get(connectionId);
    if (cached && now - cached.at < cached.ttl) return cached.value;
    const { value, ttl } = await this.readThreads(client);
    this.threadCache.set(connectionId, { value, at: now, ttl });
    return value;
  }

  private async readThreads(
    client: DatabasePort,
  ): Promise<{ value: ThreadInfo; ttl: number }> {
    const retry = (value: ThreadInfo) => ({ value, ttl: IO_THREADS_RETRY_TTL_MS });
    try {
      const info = await client.getInfoParsed();
      if (info.server?.io_threads_active !== '1') return retry({ threads: 1, note: null });
      const raw = await client.getConfigValue('io-threads');
      const threads = raw === null ? NaN : parseInt(raw, 10);
      return Number.isFinite(threads) && threads > 0
        ? { value: { threads, note: null }, ttl: IO_THREADS_TTL_MS }
        : retry({ threads: 1, note: 'thread count could not be read' });
    } catch {
      return retry({ threads: 1, note: 'thread count could not be read' });
    }
  }
}
