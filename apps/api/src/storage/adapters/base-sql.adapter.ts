/**
 * Base SQL adapter providing shared row mapping and dialect abstraction
 * for PostgreSQL and SQLite adapters.
 */
import {
  StoredAclEntry,
  StoredClientSnapshot,
  StoredAnomalyEvent,
  StoredCorrelatedGroup,
  KeyPatternSnapshot,
  AppSettings,
  Webhook,
  WebhookDelivery,
  WebhookEventType,
  StoredSlowLogEntry,
  StoredCommandLogEntry,
  CommandLogType,
} from '../../common/interfaces/storage-port.interface';

/**
 * SQL dialect abstraction for database-specific operations.
 * Implementations handle differences between PostgreSQL and SQLite.
 */
export interface SqlDialect {
  /** Convert a boolean to database format (PostgreSQL: boolean, SQLite: 0/1) */
  toBoolean(value: boolean): boolean | number;

  /** Convert database value to boolean (PostgreSQL: boolean, SQLite: 0/1) */
  fromBoolean(value: boolean | number): boolean;

  /** Convert array to database format (PostgreSQL: native, SQLite: JSON string) */
  toArray(value: string[]): string[] | string;

  /** Convert database value to array (PostgreSQL: native, SQLite: JSON parse) */
  fromArray(value: string[] | string | null): string[];

  /** Convert object to database format (PostgreSQL: JSONB, SQLite: JSON string) */
  toJson<T extends object>(value: T): T | string;

  /** Convert database value to object (PostgreSQL: JSONB auto-parsed, SQLite: JSON parse) */
  fromJson<T extends object>(value: T | string | null): T | undefined;

  /** Convert database timestamp to epoch ms (PostgreSQL: Date string, SQLite: number) */
  fromTimestamp(value: string | number | Date | null): number | undefined;

  /** Convert epoch ms to database timestamp format */
  toTimestamp(value: number): number | Date;
}

/**
 * Safely parse JSON, returning undefined on failure
 */
function safeJsonParse<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/**
 * Safely parse integer, returning undefined for NaN
 */
function safeParseInt(value: string): number | undefined {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * PostgreSQL dialect implementation
 */
export const PostgresDialect: SqlDialect = {
  toBoolean: (value: boolean) => value,
  fromBoolean: (value: boolean | number) => Boolean(value),
  toArray: (value: string[]) => value,
  fromArray: (value: string[] | string | null) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    return [];
  },
  toJson: <T extends object>(value: T) => value,
  fromJson: <T extends object>(value: T | string | null) => {
    if (!value) return undefined;
    if (typeof value === 'object') return value as T;
    if (typeof value === 'string') return safeJsonParse<T>(value);
    return undefined;
  },
  fromTimestamp: (value: string | number | Date | null) => {
    if (value === null || value === undefined) return undefined;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string') return new Date(value).getTime();
    return value;
  },
  toTimestamp: (value: number) => new Date(value),
};

/**
 * SQLite dialect implementation
 */
export const SqliteDialect: SqlDialect = {
  toBoolean: (value: boolean) => value ? 1 : 0,
  fromBoolean: (value: boolean | number) => value === 1 || value === true,
  toArray: (value: string[]) => JSON.stringify(value),
  fromArray: (value: string[] | string | null) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return safeJsonParse<string[]>(value) ?? [];
    return [];
  },
  toJson: <T extends object>(value: T) => JSON.stringify(value),
  fromJson: <T extends object>(value: T | string | null) => {
    if (!value) return undefined;
    if (typeof value === 'string') return safeJsonParse<T>(value);
    if (typeof value === 'object') return value as T;
    return undefined;
  },
  fromTimestamp: (value: string | number | Date | null) => {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'number') return value;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string') return safeParseInt(value);
    return undefined;
  },
  toTimestamp: (value: number) => value,
};

/**
 * Row mapper functions that use the dialect for conversions.
 * These eliminate duplication across adapter implementations.
 */
export class RowMappers {
  constructor(private readonly dialect: SqlDialect) {}

  /**
   * Map a database row to StoredAclEntry
   */
  mapAclEntryRow(row: any): StoredAclEntry {
    return {
      id: row.id,
      count: row.count,
      reason: row.reason,
      context: row.context,
      object: row.object,
      username: row.username,
      ageSeconds: row.age_seconds,
      clientInfo: row.client_info,
      timestampCreated: row.timestamp_created,
      timestampLastUpdated: row.timestamp_last_updated,
      capturedAt: row.captured_at,
      sourceHost: row.source_host,
      sourcePort: row.source_port,
    };
  }

  /**
   * Map a database row to StoredClientSnapshot
   */
  mapClientRow(row: any): StoredClientSnapshot {
    return {
      id: row.id,
      clientId: row.client_id,
      addr: row.addr,
      name: row.name,
      user: row.user_name ?? row.user, // pg uses user_name, sqlite uses user
      db: row.db,
      cmd: row.cmd,
      age: row.age,
      idle: row.idle,
      flags: row.flags,
      sub: row.sub,
      psub: row.psub,
      qbuf: row.qbuf,
      qbufFree: row.qbuf_free,
      obl: row.obl,
      oll: row.oll,
      omem: row.omem,
      capturedAt: row.captured_at,
      sourceHost: row.source_host,
      sourcePort: row.source_port,
    };
  }

  /**
   * Map a database row to StoredAnomalyEvent
   */
  mapAnomalyEventRow(row: any): StoredAnomalyEvent {
    return {
      id: row.id,
      timestamp: typeof row.timestamp === 'string' ? parseInt(row.timestamp, 10) : row.timestamp,
      metricType: row.metric_type,
      anomalyType: row.anomaly_type,
      severity: row.severity,
      value: typeof row.value === 'string' ? parseFloat(row.value) : row.value,
      baseline: typeof row.baseline === 'string' ? parseFloat(row.baseline) : row.baseline,
      stdDev: typeof row.std_dev === 'string' ? parseFloat(row.std_dev) : row.std_dev,
      zScore: typeof row.z_score === 'string' ? parseFloat(row.z_score) : row.z_score,
      threshold: typeof row.threshold === 'string' ? parseFloat(row.threshold) : row.threshold,
      message: row.message,
      correlationId: row.correlation_id,
      relatedMetrics: this.dialect.fromArray(row.related_metrics),
      resolved: this.dialect.fromBoolean(row.resolved),
      resolvedAt: row.resolved_at ? (typeof row.resolved_at === 'string' ? parseInt(row.resolved_at, 10) : row.resolved_at) : undefined,
      durationMs: row.duration_ms ? (typeof row.duration_ms === 'string' ? parseInt(row.duration_ms, 10) : row.duration_ms) : undefined,
      sourceHost: row.source_host,
      sourcePort: row.source_port,
    };
  }

  /**
   * Map a database row to StoredCorrelatedGroup
   */
  mapCorrelatedGroupRow(row: any): StoredCorrelatedGroup {
    return {
      correlationId: row.correlation_id,
      timestamp: typeof row.timestamp === 'string' ? parseInt(row.timestamp, 10) : row.timestamp,
      pattern: row.pattern,
      severity: row.severity,
      diagnosis: row.diagnosis,
      recommendations: this.dialect.fromArray(row.recommendations),
      anomalyCount: row.anomaly_count,
      metricTypes: this.dialect.fromArray(row.metric_types),
      sourceHost: row.source_host,
      sourcePort: row.source_port,
    };
  }

  /**
   * Map a database row to KeyPatternSnapshot
   */
  mapKeyPatternSnapshotRow(row: any): KeyPatternSnapshot {
    return {
      id: row.id,
      timestamp: typeof row.timestamp === 'string' ? parseInt(row.timestamp, 10) : row.timestamp,
      pattern: row.pattern,
      keyCount: row.key_count,
      sampledKeyCount: row.sampled_key_count,
      keysWithTtl: row.keys_with_ttl,
      keysExpiringSoon: row.keys_expiring_soon,
      totalMemoryBytes: typeof row.total_memory_bytes === 'string' ? parseInt(row.total_memory_bytes, 10) : row.total_memory_bytes,
      avgMemoryBytes: row.avg_memory_bytes,
      maxMemoryBytes: row.max_memory_bytes,
      avgAccessFrequency: row.avg_access_frequency,
      hotKeyCount: row.hot_key_count,
      coldKeyCount: row.cold_key_count,
      avgIdleTimeSeconds: row.avg_idle_time_seconds,
      staleKeyCount: row.stale_key_count,
      avgTtlSeconds: row.avg_ttl_seconds,
      minTtlSeconds: row.min_ttl_seconds,
      maxTtlSeconds: row.max_ttl_seconds,
    };
  }

  /**
   * Map a database row to AppSettings
   */
  mapSettingsRow(row: any): AppSettings {
    return {
      id: row.id,
      auditPollIntervalMs: row.audit_poll_interval_ms,
      clientAnalyticsPollIntervalMs: row.client_analytics_poll_interval_ms,
      anomalyPollIntervalMs: row.anomaly_poll_interval_ms,
      anomalyCacheTtlMs: row.anomaly_cache_ttl_ms,
      anomalyPrometheusIntervalMs: row.anomaly_prometheus_interval_ms,
      updatedAt: typeof row.updated_at === 'string' ? parseInt(row.updated_at, 10) : row.updated_at,
      createdAt: typeof row.created_at === 'string' ? parseInt(row.created_at, 10) : row.created_at,
    };
  }

  /**
   * Map a database row to Webhook
   */
  mapWebhookRow(row: any): Webhook {
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      secret: row.secret,
      enabled: this.dialect.fromBoolean(row.enabled),
      events: this.dialect.fromArray(row.events) as WebhookEventType[],
      headers: this.dialect.fromJson(row.headers) ?? {},
      retryPolicy: this.dialect.fromJson(row.retry_policy) ?? { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
      deliveryConfig: this.dialect.fromJson(row.delivery_config),
      alertConfig: this.dialect.fromJson(row.alert_config),
      thresholds: this.dialect.fromJson(row.thresholds),
      createdAt: this.dialect.fromTimestamp(row.created_at) ?? 0,
      updatedAt: this.dialect.fromTimestamp(row.updated_at) ?? 0,
    };
  }

  /**
   * Map a database row to WebhookDelivery
   */
  mapDeliveryRow(row: any): WebhookDelivery {
    return {
      id: row.id,
      webhookId: row.webhook_id,
      eventType: row.event_type,
      payload: this.dialect.fromJson(row.payload) ?? {},
      status: row.status,
      statusCode: row.status_code,
      responseBody: row.response_body,
      attempts: row.attempts,
      nextRetryAt: this.dialect.fromTimestamp(row.next_retry_at),
      createdAt: this.dialect.fromTimestamp(row.created_at) ?? 0,
      completedAt: this.dialect.fromTimestamp(row.completed_at),
      durationMs: row.duration_ms,
    };
  }

  /**
   * Map a database row to StoredSlowLogEntry
   */
  mapSlowLogEntryRow(row: any): StoredSlowLogEntry {
    return {
      id: typeof row.slowlog_id === 'string' ? parseInt(row.slowlog_id, 10) : row.slowlog_id,
      timestamp: typeof row.timestamp === 'string' ? parseInt(row.timestamp, 10) : row.timestamp,
      duration: typeof row.duration === 'string' ? parseInt(row.duration, 10) : row.duration,
      command: this.dialect.fromArray(row.command),
      clientAddress: row.client_address,
      clientName: row.client_name,
      capturedAt: typeof row.captured_at === 'string' ? parseInt(row.captured_at, 10) : row.captured_at,
      sourceHost: row.source_host,
      sourcePort: row.source_port,
    };
  }

  /**
   * Map a database row to StoredCommandLogEntry
   */
  mapCommandLogEntryRow(row: any): StoredCommandLogEntry {
    return {
      id: typeof row.commandlog_id === 'string' ? parseInt(row.commandlog_id, 10) : row.commandlog_id,
      timestamp: typeof row.timestamp === 'string' ? parseInt(row.timestamp, 10) : row.timestamp,
      duration: typeof row.duration === 'string' ? parseInt(row.duration, 10) : row.duration,
      command: this.dialect.fromArray(row.command),
      clientAddress: row.client_address,
      clientName: row.client_name,
      type: row.log_type as CommandLogType,
      capturedAt: typeof row.captured_at === 'string' ? parseInt(row.captured_at, 10) : row.captured_at,
      sourceHost: row.source_host,
      sourcePort: row.source_port,
    };
  }
}
