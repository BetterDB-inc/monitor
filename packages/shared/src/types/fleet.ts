/**
 * Fleet summary types for the multi-instance "are we green?" view.
 *
 * Served by GET /fleet/summary. Each entry is a lightweight rollup of
 * HealthService.getHealth() + INFO memory/stats/clients/replication/server
 * sections for one registered connection. `null` means "unknown" (down,
 * timed out, or section missing) — never 0, so "no data" stays
 * distinguishable from a real zero.
 */

export type FleetInstanceStatus = 'up' | 'down' | 'unknown';

export interface FleetInstanceSummary {
  connectionId: string;
  name: string;
  host: string;
  port: number;
  /** Rollup of HealthResponse.status: connected -> up, disconnected/error -> down. */
  status: FleetInstanceStatus;
  uptimeSec: number | null;
  memoryUsedBytes: number | null;
  memoryMaxBytes: number | null;
  /** Null when maxmemory is 0/unset (no limit) or values unknown. */
  memPct: number | null;
  opsPerSec: number | null;
  connectedClients: number | null;
  replicationRole: string | null;
  /** Last successful collection (Unix ms). Null when never seen up. */
  lastSeen: number | null;
  /** Present when the instance is down/unknown (ping failed, timeout, ...). */
  error?: string;
}

export type FleetOverallStatus = 'healthy' | 'degraded' | 'unhealthy' | 'waiting';

export interface FleetSummaryResponse {
  overallStatus: FleetOverallStatus;
  instances: FleetInstanceSummary[];
  timestamp: number;
}
