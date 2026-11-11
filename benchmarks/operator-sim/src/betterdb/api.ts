import type { SimConfig } from '../config.js';

// Subset of BetterDB's REST shapes we read (packages/shared/src/types/connections.ts,
// proprietary/anomaly-detection/types.ts). Unknown fields are kept as-is in jsonl.
export interface Connection {
  id: string;
  name: string;
  host: string;
  port: number;
  isConnected: boolean;
  autoRegisterNodes?: boolean;
  membership?: { seedId: string; nodeId: string; role?: string; retiredAt?: number };
}
export interface AnomalyEvent {
  id: string;
  timestamp: number;
  metricType: string;
  anomalyType: string;
  severity: string;
  value: number;
  baseline: number;
  zScore: number;
  message: string;
  correlationId?: string;
  nodeAddr?: string;
  replicaAddr?: string;
  connectionId?: string;
  resolved: boolean;
}
export interface AnomalyGroup {
  correlationId: string;
  timestamp: number;
  anomalies: AnomalyEvent[];
  pattern: string;
  diagnosis: string;
  recommendations: string[];
  severity: string;
}
export interface FanoutCoverage { connectionId: string; topology: string | null; checked: number; unreachable: number; authFailed: number; skipped: number; notDialed: number; reason: string | null }

export class BetterdbApi {
  constructor(private readonly cfg: SimConfig) {}

  private async get<T>(path: string, query: Record<string, string | number | undefined> = {}, connectionId?: string): Promise<T> {
    const u = new URL(`/api${path}`, this.cfg.betterdb.url);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
    const r = await fetch(u, { headers: connectionId ? { 'x-connection-id': connectionId } : {}, signal: AbortSignal.timeout(this.cfg.betterdb.requestTimeoutMs) });
    if (!r.ok) throw new Error(`GET ${u.pathname}${u.search} → ${r.status} ${(await r.text()).slice(0, 300)}`);
    return (await r.json()) as T;
  }

  connections() {
    return this.get<{ connections: Connection[]; currentId: string | null; autoRegisterNodesDefault: boolean }>('/connections');
  }
  events(startTime: number, endTime?: number, connectionId?: string) {
    return this.get<AnomalyEvent[]>('/anomaly/events', { startTime, endTime, limit: this.cfg.betterdb.eventLimit }, connectionId);
  }
  groups(startTime: number, endTime?: number, connectionId?: string) {
    return this.get<AnomalyGroup[]>('/anomaly/groups', { startTime, endTime, limit: this.cfg.betterdb.eventLimit }, connectionId);
  }
  buffers(connectionId: string) {
    return this.get<{ metricType: string; sampleCount: number; isReady: boolean }[]>('/anomaly/buffers', {}, connectionId);
  }
  coverage(connectionId?: string) {
    return this.get<FanoutCoverage[]>('/anomaly/coverage', {}, connectionId);
  }
}
