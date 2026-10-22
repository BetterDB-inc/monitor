import { Injectable } from '@nestjs/common';
import { AuditStats } from '../common/interfaces/storage-port.interface';

interface CachedAuditStats {
  stats: AuditStats;
  /** Date.now() when the stats were read from storage. */
  refreshedAt: number;
}

/**
 * Per-connection ACL audit totals computed by the AuditService poller, read
 * synchronously by the Prometheus storage phase so a scrape never aggregates
 * the ACL table itself.
 */
@Injectable()
export class AuditStatsCacheService {
  private readonly stats = new Map<string, CachedAuditStats>();

  get(connectionId: string): AuditStats | null {
    return this.stats.get(connectionId)?.stats ?? null;
  }

  /** When the cached stats for the connection were last refreshed, or null if none are cached. */
  getRefreshedAt(connectionId: string): number | null {
    return this.stats.get(connectionId)?.refreshedAt ?? null;
  }

  set(connectionId: string, stats: AuditStats, refreshedAt: number = Date.now()): void {
    this.stats.set(connectionId, { stats, refreshedAt });
  }

  delete(connectionId: string): void {
    this.stats.delete(connectionId);
  }
}
