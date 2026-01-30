// SQLite adapter for local development only
// This file is excluded from Docker builds via .dockerignore
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import {
  StoragePort,
  StoredAclEntry,
  AuditQueryOptions,
  AuditStats,
  StoredClientSnapshot,
  ClientSnapshotQueryOptions,
  ClientTimeSeriesPoint,
  ClientAnalyticsStats,
  StoredAnomalyEvent,
  StoredCorrelatedGroup,
  AnomalyQueryOptions,
  AnomalyStats,
  KeyPatternSnapshot,
  KeyPatternQueryOptions,
  KeyAnalyticsSummary,
  AppSettings,
  SettingsUpdateRequest,
  Webhook,
  WebhookDelivery,
  WebhookEventType,
  DeliveryStatus,
  StoredSlowLogEntry,
  SlowLogQueryOptions,
  StoredCommandLogEntry,
  CommandLogQueryOptions,
  CommandLogType,
} from '../../common/interfaces/storage-port.interface';
import { SqliteDialect, RowMappers } from './base-sql.adapter';

export interface SqliteAdapterConfig {
  filepath: string;
}

export class SqliteAdapter implements StoragePort {
  private db: Database.Database | null = null;
  private ready: boolean = false;
  private readonly mappers = new RowMappers(SqliteDialect);

  constructor(private config: SqliteAdapterConfig) { }

  async initialize(): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.config.filepath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Open database with WAL mode for better concurrency
      this.db = new Database(this.config.filepath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');

      // Create schema
      this.createSchema();
      // Run migrations for existing databases
      this.runMigrations();
      this.ready = true;
    } catch (error) {
      this.ready = false;
      throw new Error(`Failed to initialize SQLite: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Run migrations to add new columns to existing databases
   */
  private runMigrations(): void {
    if (!this.db) return;

    // Get existing columns in webhooks table
    const tableInfo = this.db.prepare("PRAGMA table_info(webhooks)").all() as { name: string }[];
    const existingColumns = new Set(tableInfo.map(col => col.name));

    // Add new columns if they don't exist
    const newColumns = [
      { name: 'delivery_config', type: 'TEXT' },
      { name: 'alert_config', type: 'TEXT' },
      { name: 'thresholds', type: 'TEXT' },
    ];

    for (const col of newColumns) {
      if (!existingColumns.has(col.name)) {
        this.db.exec(`ALTER TABLE webhooks ADD COLUMN ${col.name} ${col.type}`);
      }
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.ready = false;
    }
  }

  isReady(): boolean {
    return this.ready && this.db !== null;
  }

  async saveAclEntries(entries: StoredAclEntry[]): Promise<number> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const insert = this.db.prepare(`
      INSERT INTO acl_audit (
        count,
        reason,
        context,
        object,
        username,
        age_seconds,
        client_info,
        timestamp_created,
        timestamp_last_updated,
        captured_at,
        source_host,
        source_port
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(timestamp_created, username, object, reason, source_host, source_port)
      DO UPDATE SET
        count = excluded.count,
        age_seconds = excluded.age_seconds,
        timestamp_last_updated = excluded.timestamp_last_updated,
        captured_at = excluded.captured_at
    `);

    const insertMany = this.db.transaction((entries: StoredAclEntry[]) => {
      for (const entry of entries) {
        insert.run(
          entry.count,
          entry.reason,
          entry.context,
          entry.object,
          entry.username,
          entry.ageSeconds,
          entry.clientInfo,
          entry.timestampCreated,
          entry.timestampLastUpdated,
          entry.capturedAt,
          entry.sourceHost,
          entry.sourcePort,
        );
      }
    });

    insertMany(entries);
    return entries.length;
  }

  async getAclEntries(options: AuditQueryOptions = {}): Promise<StoredAclEntry[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.username) {
      conditions.push('username = ?');
      params.push(options.username);
    }

    if (options.reason) {
      conditions.push('reason = ?');
      params.push(options.reason);
    }

    if (options.startTime) {
      conditions.push('captured_at >= ?');
      params.push(options.startTime);
    }

    if (options.endTime) {
      conditions.push('captured_at <= ?');
      params.push(options.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const query = `
      SELECT * FROM acl_audit
      ${whereClause}
      ORDER BY captured_at DESC, id DESC
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    const rows = this.db.prepare(query).all(...params) as any[];

    return rows.map((row) => this.mappers.mapAclEntryRow(row));
  }

  async getAuditStats(startTime?: number, endTime?: number): Promise<AuditStats> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const conditions: string[] = [];
    const params: number[] = [];

    if (startTime) {
      conditions.push('captured_at >= ?');
      params.push(startTime);
    }

    if (endTime) {
      conditions.push('captured_at <= ?');
      params.push(endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Total entries
    const totalResult = this.db
      .prepare(`SELECT COUNT(*) as count FROM acl_audit ${whereClause}`)
      .get(...params) as { count: number };

    // Unique users
    const uniqueUsersResult = this.db
      .prepare(`SELECT COUNT(DISTINCT username) as count FROM acl_audit ${whereClause}`)
      .get(...params) as { count: number };

    // Entries by reason
    const byReasonRows = this.db
      .prepare(`SELECT reason, COUNT(*) as count FROM acl_audit ${whereClause} GROUP BY reason`)
      .all(...params) as Array<{ reason: string; count: number }>;

    const entriesByReason: Record<string, number> = {};
    for (const row of byReasonRows) {
      entriesByReason[row.reason] = row.count;
    }

    // Entries by user
    const byUserRows = this.db
      .prepare(`SELECT username, COUNT(*) as count FROM acl_audit ${whereClause} GROUP BY username`)
      .all(...params) as Array<{ username: string; count: number }>;

    const entriesByUser: Record<string, number> = {};
    for (const row of byUserRows) {
      entriesByUser[row.username] = row.count;
    }

    // Time range
    const timeRangeResult = this.db
      .prepare(`SELECT MIN(captured_at) as earliest, MAX(captured_at) as latest FROM acl_audit ${whereClause}`)
      .get(...params) as { earliest: number | null; latest: number | null };

    const timeRange =
      timeRangeResult.earliest !== null && timeRangeResult.latest !== null
        ? { earliest: timeRangeResult.earliest, latest: timeRangeResult.latest }
        : null;

    return {
      totalEntries: totalResult.count,
      uniqueUsers: uniqueUsersResult.count,
      entriesByReason,
      entriesByUser,
      timeRange,
    };
  }

  async pruneOldEntries(olderThanTimestamp: number): Promise<number> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const result = this.db.prepare('DELETE FROM acl_audit WHERE captured_at < ?').run(olderThanTimestamp);

    return result.changes;
  }

  async saveClientSnapshot(clients: StoredClientSnapshot[]): Promise<number> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const insert = this.db.prepare(`
      INSERT INTO client_snapshots (
        client_id, addr, name, user, db, cmd, age, idle, flags,
        sub, psub, qbuf, qbuf_free, obl, oll, omem,
        captured_at, source_host, source_port
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((clients: StoredClientSnapshot[]) => {
      for (const client of clients) {
        insert.run(
          client.clientId,
          client.addr,
          client.name,
          client.user,
          client.db,
          client.cmd,
          client.age,
          client.idle,
          client.flags,
          client.sub,
          client.psub,
          client.qbuf,
          client.qbufFree,
          client.obl,
          client.oll,
          client.omem,
          client.capturedAt,
          client.sourceHost,
          client.sourcePort,
        );
      }
    });

    insertMany(clients);
    return clients.length;
  }

  async getClientSnapshots(options: ClientSnapshotQueryOptions = {}): Promise<StoredClientSnapshot[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.clientName) {
      conditions.push('name = ?');
      params.push(options.clientName);
    }

    if (options.user) {
      conditions.push('user = ?');
      params.push(options.user);
    }

    if (options.addr) {
      if (options.addr.includes('%')) {
        conditions.push('addr LIKE ?');
      } else {
        conditions.push('addr = ?');
      }
      params.push(options.addr);
    }

    if (options.startTime) {
      conditions.push('captured_at >= ?');
      params.push(options.startTime);
    }

    if (options.endTime) {
      conditions.push('captured_at <= ?');
      params.push(options.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const query = `
      SELECT * FROM client_snapshots
      ${whereClause}
      ORDER BY captured_at DESC, id DESC
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    const rows = this.db.prepare(query).all(...params) as any[];

    return rows.map((row) => this.mappers.mapClientRow(row));
  }

  async getClientTimeSeries(startTime: number, endTime: number, bucketSizeMs: number = 60000): Promise<ClientTimeSeriesPoint[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const query = `
      SELECT
        (captured_at / ? * ?) as bucket_time,
        COUNT(*) as total_connections,
        name,
        user,
        addr
      FROM client_snapshots
      WHERE captured_at >= ? AND captured_at <= ?
      GROUP BY bucket_time, name, user, addr
      ORDER BY bucket_time
    `;

    const rows = this.db.prepare(query).all(bucketSizeMs, bucketSizeMs, startTime, endTime) as Array<{
      bucket_time: number;
      total_connections: number;
      name: string;
      user: string;
      addr: string;
    }>;

    const pointsMap = new Map<number, ClientTimeSeriesPoint>();

    for (const row of rows) {
      if (!pointsMap.has(row.bucket_time)) {
        pointsMap.set(row.bucket_time, {
          timestamp: row.bucket_time,
          totalConnections: 0,
          byName: {},
          byUser: {},
          byAddr: {},
        });
      }

      const point = pointsMap.get(row.bucket_time)!;
      point.totalConnections += row.total_connections;

      if (row.name) {
        point.byName[row.name] = (point.byName[row.name] || 0) + 1;
      }
      if (row.user) {
        point.byUser[row.user] = (point.byUser[row.user] || 0) + 1;
      }
      const ip = row.addr.split(':')[0];
      point.byAddr[ip] = (point.byAddr[ip] || 0) + 1;
    }

    return Array.from(pointsMap.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  async getClientAnalyticsStats(startTime?: number, endTime?: number): Promise<ClientAnalyticsStats> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const conditions: string[] = [];
    const params: number[] = [];

    if (startTime) {
      conditions.push('captured_at >= ?');
      params.push(startTime);
    }

    if (endTime) {
      conditions.push('captured_at <= ?');
      params.push(endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const latestTimestamp = this.db
      .prepare(`SELECT MAX(captured_at) as latest FROM client_snapshots ${whereClause}`)
      .get(...params) as { latest: number | null };

    const currentConditions = latestTimestamp.latest
      ? [...conditions, 'captured_at = ?']
      : conditions;
    const currentParams = latestTimestamp.latest
      ? [...params, latestTimestamp.latest]
      : params;
    const currentWhereClause = currentConditions.length > 0 ? `WHERE ${currentConditions.join(' AND ')}` : '';

    const currentConnectionsResult = this.db
      .prepare(`SELECT COUNT(*) as count FROM client_snapshots ${currentWhereClause}`)
      .get(...currentParams) as { count: number };

    const peakQuery = `
      SELECT captured_at, COUNT(*) as count
      FROM client_snapshots ${whereClause}
      GROUP BY captured_at
      ORDER BY count DESC
      LIMIT 1
    `;
    const peakResult = this.db.prepare(peakQuery).get(...params) as { captured_at: number; count: number } | undefined;

    const uniqueNamesResult = this.db
      .prepare(`SELECT COUNT(DISTINCT name) as count FROM client_snapshots ${whereClause}`)
      .get(...params) as { count: number };

    const uniqueUsersResult = this.db
      .prepare(`SELECT COUNT(DISTINCT user) as count FROM client_snapshots ${whereClause}`)
      .get(...params) as { count: number };

    const uniqueIpsResult = this.db
      .prepare(`SELECT COUNT(DISTINCT substr(addr, 1, instr(addr, ':') - 1)) as count FROM client_snapshots ${whereClause}`)
      .get(...params) as { count: number };

    const byNameRows = this.db.prepare(`
      SELECT
        name,
        COUNT(*) as total,
        AVG(age) as avg_age
      FROM client_snapshots ${whereClause}
      GROUP BY name
    `).all(...params) as Array<{ name: string; total: number; avg_age: number }>;

    const connectionsByName: Record<string, { current: number; peak: number; avgAge: number }> = {};
    for (const row of byNameRows) {
      if (row.name) {
        const namePeakResult = this.db.prepare(`
          SELECT captured_at, COUNT(*) as count
          FROM client_snapshots
          WHERE name = ? ${whereClause ? 'AND ' + whereClause.substring(6) : ''}
          GROUP BY captured_at
          ORDER BY count DESC
          LIMIT 1
        `).get(row.name, ...params) as { count: number } | undefined;

        const nameCurrentResult = this.db.prepare(`
          SELECT COUNT(*) as count
          FROM client_snapshots
          WHERE name = ? ${currentWhereClause ? 'AND ' + currentWhereClause.substring(6) : ''}
        `).get(row.name, ...currentParams) as { count: number };

        connectionsByName[row.name] = {
          current: nameCurrentResult.count,
          peak: namePeakResult?.count || 0,
          avgAge: row.avg_age,
        };
      }
    }

    const byUserRows = this.db.prepare(`
      SELECT user, COUNT(*) as total
      FROM client_snapshots ${whereClause}
      GROUP BY user
    `).all(...params) as Array<{ user: string; total: number }>;

    const connectionsByUser: Record<string, { current: number; peak: number }> = {};
    for (const row of byUserRows) {
      if (row.user) {
        const userPeakResult = this.db.prepare(`
          SELECT captured_at, COUNT(*) as count
          FROM client_snapshots
          WHERE user = ? ${whereClause ? 'AND ' + whereClause.substring(6) : ''}
          GROUP BY captured_at
          ORDER BY count DESC
          LIMIT 1
        `).get(row.user, ...params) as { count: number } | undefined;

        const userCurrentResult = this.db.prepare(`
          SELECT COUNT(*) as count
          FROM client_snapshots
          WHERE user = ? ${currentWhereClause ? 'AND ' + currentWhereClause.substring(6) : ''}
        `).get(row.user, ...currentParams) as { count: number };

        connectionsByUser[row.user] = {
          current: userCurrentResult.count,
          peak: userPeakResult?.count || 0,
        };
      }
    }

    const byUserAndNameRows = this.db.prepare(`
      SELECT
        user,
        name,
        COUNT(*) as total,
        AVG(age) as avg_age
      FROM client_snapshots ${whereClause}
      GROUP BY user, name
    `).all(...params) as Array<{ user: string; name: string; total: number; avg_age: number }>;

    const connectionsByUserAndName: Record<string, { user: string; name: string; current: number; peak: number; avgAge: number }> = {};
    for (const row of byUserAndNameRows) {
      const key = `${row.user}:${row.name}`;

      const combinedPeakResult = this.db.prepare(`
        SELECT captured_at, COUNT(*) as count
        FROM client_snapshots
        WHERE user = ? AND name = ? ${whereClause ? 'AND ' + whereClause.substring(6) : ''}
        GROUP BY captured_at
        ORDER BY count DESC
        LIMIT 1
      `).get(row.user, row.name, ...params) as { count: number } | undefined;

      const combinedCurrentResult = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM client_snapshots
        WHERE user = ? AND name = ? ${currentWhereClause ? 'AND ' + currentWhereClause.substring(6) : ''}
      `).get(row.user, row.name, ...currentParams) as { count: number };

      connectionsByUserAndName[key] = {
        user: row.user,
        name: row.name,
        current: combinedCurrentResult.count,
        peak: combinedPeakResult?.count || 0,
        avgAge: row.avg_age,
      };
    }

    const timeRangeResult = this.db
      .prepare(`SELECT MIN(captured_at) as earliest, MAX(captured_at) as latest FROM client_snapshots ${whereClause}`)
      .get(...params) as { earliest: number | null; latest: number | null };

    const timeRange =
      timeRangeResult.earliest !== null && timeRangeResult.latest !== null
        ? { earliest: timeRangeResult.earliest, latest: timeRangeResult.latest }
        : null;

    return {
      currentConnections: currentConnectionsResult.count,
      peakConnections: peakResult?.count || 0,
      peakTimestamp: peakResult?.captured_at || 0,
      uniqueClientNames: uniqueNamesResult.count,
      uniqueUsers: uniqueUsersResult.count,
      uniqueIps: uniqueIpsResult.count,
      connectionsByName,
      connectionsByUser,
      connectionsByUserAndName,
      timeRange,
    };
  }

  async getClientConnectionHistory(
    identifier: { name?: string; user?: string; addr?: string },
    startTime?: number,
    endTime?: number,
  ): Promise<StoredClientSnapshot[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (identifier.name) {
      conditions.push('name = ?');
      params.push(identifier.name);
    }

    if (identifier.user) {
      conditions.push('user = ?');
      params.push(identifier.user);
    }

    if (identifier.addr) {
      conditions.push('addr = ?');
      params.push(identifier.addr);
    }

    if (startTime) {
      conditions.push('captured_at >= ?');
      params.push(startTime);
    }

    if (endTime) {
      conditions.push('captured_at <= ?');
      params.push(endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
      SELECT * FROM client_snapshots
      ${whereClause}
      ORDER BY captured_at ASC
    `;

    const rows = this.db.prepare(query).all(...params) as any[];

    return rows.map((row) => this.mappers.mapClientRow(row));
  }

  async pruneOldClientSnapshots(olderThanTimestamp: number): Promise<number> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const result = this.db.prepare('DELETE FROM client_snapshots WHERE captured_at < ?').run(olderThanTimestamp);

    return result.changes;
  }

  private createSchema(): void {
    if (!this.db) {
      return;
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS acl_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        count INTEGER NOT NULL,
        reason TEXT NOT NULL,
        context TEXT NOT NULL,
        object TEXT NOT NULL,
        username TEXT NOT NULL,
        age_seconds INTEGER NOT NULL,
        client_info TEXT NOT NULL,
        timestamp_created INTEGER NOT NULL,
        timestamp_last_updated INTEGER NOT NULL,
        captured_at INTEGER NOT NULL,
        source_host TEXT NOT NULL,
        source_port INTEGER NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(timestamp_created, username, object, reason, source_host, source_port)
      );

      CREATE INDEX IF NOT EXISTS idx_acl_username ON acl_audit(username);
      CREATE INDEX IF NOT EXISTS idx_acl_reason ON acl_audit(reason);
      CREATE INDEX IF NOT EXISTS idx_acl_captured_at ON acl_audit(captured_at);
      CREATE INDEX IF NOT EXISTS idx_acl_timestamp_created ON acl_audit(timestamp_created);

      CREATE TABLE IF NOT EXISTS client_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT NOT NULL,
        addr TEXT NOT NULL,
        name TEXT,
        user TEXT,
        db INTEGER NOT NULL,
        cmd TEXT,
        age INTEGER NOT NULL,
        idle INTEGER NOT NULL,
        flags TEXT,
        sub INTEGER NOT NULL DEFAULT 0,
        psub INTEGER NOT NULL DEFAULT 0,
        qbuf INTEGER NOT NULL DEFAULT 0,
        qbuf_free INTEGER NOT NULL DEFAULT 0,
        obl INTEGER NOT NULL DEFAULT 0,
        oll INTEGER NOT NULL DEFAULT 0,
        omem INTEGER NOT NULL DEFAULT 0,
        captured_at INTEGER NOT NULL,
        source_host TEXT NOT NULL,
        source_port INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_client_captured_at ON client_snapshots(captured_at);
      CREATE INDEX IF NOT EXISTS idx_client_name ON client_snapshots(name);
      CREATE INDEX IF NOT EXISTS idx_client_user ON client_snapshots(user);
      CREATE INDEX IF NOT EXISTS idx_client_addr ON client_snapshots(addr);
      CREATE INDEX IF NOT EXISTS idx_client_idle ON client_snapshots(idle) WHERE idle > 300;
      CREATE INDEX IF NOT EXISTS idx_client_qbuf ON client_snapshots(qbuf) WHERE qbuf > 1000000;
      CREATE INDEX IF NOT EXISTS idx_client_omem ON client_snapshots(omem) WHERE omem > 10000000;
      CREATE INDEX IF NOT EXISTS idx_client_cmd ON client_snapshots(cmd);
      CREATE INDEX IF NOT EXISTS idx_client_captured_at_cmd ON client_snapshots(captured_at, cmd);

      -- Anomaly Events Table
      CREATE TABLE IF NOT EXISTS anomaly_events (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        metric_type TEXT NOT NULL,
        anomaly_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        value REAL NOT NULL,
        baseline REAL NOT NULL,
        std_dev REAL NOT NULL,
        z_score REAL NOT NULL,
        threshold REAL NOT NULL,
        message TEXT NOT NULL,
        correlation_id TEXT,
        related_metrics TEXT,
        resolved INTEGER DEFAULT 0,
        resolved_at INTEGER,
        duration_ms INTEGER,
        source_host TEXT,
        source_port INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_anomaly_events_timestamp ON anomaly_events(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_anomaly_events_severity ON anomaly_events(severity, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_anomaly_events_metric ON anomaly_events(metric_type, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_anomaly_events_correlation ON anomaly_events(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_anomaly_events_unresolved ON anomaly_events(resolved, timestamp DESC) WHERE resolved = 0;

      -- Correlated Anomaly Groups Table
      CREATE TABLE IF NOT EXISTS correlated_anomaly_groups (
        correlation_id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        pattern TEXT NOT NULL,
        severity TEXT NOT NULL,
        diagnosis TEXT NOT NULL,
        recommendations TEXT NOT NULL,
        anomaly_count INTEGER NOT NULL,
        metric_types TEXT NOT NULL,
        source_host TEXT,
        source_port INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_correlated_groups_timestamp ON correlated_anomaly_groups(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_correlated_groups_pattern ON correlated_anomaly_groups(pattern, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_correlated_groups_severity ON correlated_anomaly_groups(severity, timestamp DESC);

      CREATE TABLE IF NOT EXISTS key_pattern_snapshots (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        pattern TEXT NOT NULL,
        key_count INTEGER NOT NULL,
        sampled_key_count INTEGER NOT NULL,
        keys_with_ttl INTEGER NOT NULL,
        keys_expiring_soon INTEGER NOT NULL,
        total_memory_bytes INTEGER NOT NULL,
        avg_memory_bytes INTEGER NOT NULL,
        max_memory_bytes INTEGER NOT NULL,
        avg_access_frequency REAL,
        hot_key_count INTEGER,
        cold_key_count INTEGER,
        avg_idle_time_seconds REAL,
        stale_key_count INTEGER,
        avg_ttl_seconds INTEGER,
        min_ttl_seconds INTEGER,
        max_ttl_seconds INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_kps_timestamp ON key_pattern_snapshots(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_kps_pattern ON key_pattern_snapshots(pattern, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_kps_pattern_timestamp ON key_pattern_snapshots(pattern, timestamp);

      CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        audit_poll_interval_ms INTEGER NOT NULL DEFAULT 60000,
        client_analytics_poll_interval_ms INTEGER NOT NULL DEFAULT 60000,
        anomaly_poll_interval_ms INTEGER NOT NULL DEFAULT 1000,
        anomaly_cache_ttl_ms INTEGER NOT NULL DEFAULT 3600000,
        anomaly_prometheus_interval_ms INTEGER NOT NULL DEFAULT 30000,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
      );

      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        secret TEXT,
        enabled INTEGER DEFAULT 1,
        events TEXT NOT NULL,
        headers TEXT DEFAULT '{}',
        retry_policy TEXT NOT NULL,
        delivery_config TEXT,
        alert_config TEXT,
        thresholds TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      );

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        status_code INTEGER,
        response_body TEXT,
        attempts INTEGER DEFAULT 0,
        next_retry_at INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        completed_at INTEGER,
        duration_ms INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id);
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry ON webhook_deliveries(next_retry_at) WHERE status = 'retrying';

      CREATE TABLE IF NOT EXISTS slow_log_entries (
        pk INTEGER PRIMARY KEY AUTOINCREMENT,
        slowlog_id INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        duration INTEGER NOT NULL,
        command TEXT NOT NULL DEFAULT '[]',
        client_address TEXT,
        client_name TEXT,
        captured_at INTEGER NOT NULL,
        source_host TEXT NOT NULL,
        source_port INTEGER NOT NULL,
        UNIQUE(slowlog_id, source_host, source_port)
      );

      CREATE INDEX IF NOT EXISTS idx_slowlog_timestamp ON slow_log_entries(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_slowlog_command ON slow_log_entries(command);
      CREATE INDEX IF NOT EXISTS idx_slowlog_duration ON slow_log_entries(duration DESC);
      CREATE INDEX IF NOT EXISTS idx_slowlog_client_name ON slow_log_entries(client_name);
      CREATE INDEX IF NOT EXISTS idx_slowlog_captured_at ON slow_log_entries(captured_at DESC);
    `);
  }

  async saveAnomalyEvent(event: StoredAnomalyEvent): Promise<string> {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      INSERT INTO anomaly_events (
        id, timestamp, metric_type, anomaly_type, severity,
        value, baseline, std_dev, z_score, threshold,
        message, correlation_id, related_metrics,
        resolved, resolved_at, duration_ms,
        source_host, source_port
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        correlation_id = excluded.correlation_id,
        resolved = excluded.resolved,
        resolved_at = excluded.resolved_at,
        duration_ms = excluded.duration_ms
    `);

    stmt.run(
      event.id,
      event.timestamp,
      event.metricType,
      event.anomalyType,
      event.severity,
      event.value,
      event.baseline,
      event.stdDev,
      event.zScore,
      event.threshold,
      event.message,
      event.correlationId || null,
      event.relatedMetrics ? JSON.stringify(event.relatedMetrics) : null,
      event.resolved ? 1 : 0,
      event.resolvedAt || null,
      event.durationMs || null,
      event.sourceHost || null,
      event.sourcePort || null
    );

    return event.id;
  }

  async saveAnomalyEvents(events: StoredAnomalyEvent[]): Promise<number> {
    if (!this.db || events.length === 0) return 0;

    const stmt = this.db.prepare(`
      INSERT INTO anomaly_events (
        id, timestamp, metric_type, anomaly_type, severity,
        value, baseline, std_dev, z_score, threshold,
        message, correlation_id, related_metrics,
        resolved, resolved_at, duration_ms,
        source_host, source_port
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((events: StoredAnomalyEvent[]) => {
      for (const event of events) {
        stmt.run(
          event.id,
          event.timestamp,
          event.metricType,
          event.anomalyType,
          event.severity,
          event.value,
          event.baseline,
          event.stdDev,
          event.zScore,
          event.threshold,
          event.message,
          event.correlationId || null,
          event.relatedMetrics ? JSON.stringify(event.relatedMetrics) : null,
          event.resolved ? 1 : 0,
          event.resolvedAt || null,
          event.durationMs || null,
          event.sourceHost || null,
          event.sourcePort || null
        );
      }
    });

    insertMany(events);
    return events.length;
  }

  async getAnomalyEvents(options: AnomalyQueryOptions = {}): Promise<StoredAnomalyEvent[]> {
    if (!this.db) throw new Error('Database not initialized');

    const conditions: string[] = [];
    const params: any[] = [];

    if (options.startTime) {
      conditions.push('timestamp >= ?');
      params.push(options.startTime);
    }
    if (options.endTime) {
      conditions.push('timestamp <= ?');
      params.push(options.endTime);
    }
    if (options.severity) {
      conditions.push('severity = ?');
      params.push(options.severity);
    }
    if (options.metricType) {
      conditions.push('metric_type = ?');
      params.push(options.metricType);
    }
    if (options.resolved !== undefined) {
      conditions.push('resolved = ?');
      params.push(options.resolved ? 1 : 0);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const query = `
      SELECT * FROM anomaly_events
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    const rows = this.db.prepare(query).all(...params) as any[];

    return rows.map((row) => this.mappers.mapAnomalyEventRow(row));
  }

  async getAnomalyStats(startTime?: number, endTime?: number): Promise<AnomalyStats> {
    if (!this.db) throw new Error('Database not initialized');

    const conditions: string[] = [];
    const params: number[] = [];

    if (startTime) {
      conditions.push('timestamp >= ?');
      params.push(startTime);
    }
    if (endTime) {
      conditions.push('timestamp <= ?');
      params.push(endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const totalResult = this.db
      .prepare(`SELECT COUNT(*) as count FROM anomaly_events ${whereClause}`)
      .get(...params) as { count: number };

    const severityResult = this.db
      .prepare(`SELECT severity, COUNT(*) as count FROM anomaly_events ${whereClause} GROUP BY severity`)
      .all(...params) as Array<{ severity: string; count: number }>;

    const metricResult = this.db
      .prepare(`SELECT metric_type, COUNT(*) as count FROM anomaly_events ${whereClause} GROUP BY metric_type`)
      .all(...params) as Array<{ metric_type: string; count: number }>;

    const unresolvedResult = this.db
      .prepare(`SELECT COUNT(*) as count FROM anomaly_events ${whereClause ? whereClause + ' AND' : 'WHERE'} resolved = 0`)
      .get(...params) as { count: number };

    const bySeverity: Record<string, number> = {};
    for (const row of severityResult) {
      bySeverity[row.severity] = row.count;
    }

    const byMetric: Record<string, number> = {};
    for (const row of metricResult) {
      byMetric[row.metric_type] = row.count;
    }

    return {
      totalEvents: totalResult.count,
      bySeverity,
      byMetric,
      byPattern: {},
      unresolvedCount: unresolvedResult.count,
    };
  }

  async resolveAnomaly(id: string, resolvedAt: number): Promise<boolean> {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      UPDATE anomaly_events
      SET resolved = 1, resolved_at = ?, duration_ms = ? - timestamp
      WHERE id = ? AND resolved = 0
    `);

    const result = stmt.run(resolvedAt, resolvedAt, id);
    return result.changes > 0;
  }

  async pruneOldAnomalyEvents(cutoffTimestamp: number): Promise<number> {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.prepare('DELETE FROM anomaly_events WHERE timestamp < ?').run(cutoffTimestamp);
    return result.changes;
  }

  async saveCorrelatedGroup(group: StoredCorrelatedGroup): Promise<string> {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      INSERT INTO correlated_anomaly_groups (
        correlation_id, timestamp, pattern, severity,
        diagnosis, recommendations, anomaly_count, metric_types,
        source_host, source_port
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(correlation_id) DO UPDATE SET
        diagnosis = excluded.diagnosis,
        recommendations = excluded.recommendations,
        anomaly_count = excluded.anomaly_count
    `);

    stmt.run(
      group.correlationId,
      group.timestamp,
      group.pattern,
      group.severity,
      group.diagnosis,
      JSON.stringify(group.recommendations),
      group.anomalyCount,
      JSON.stringify(group.metricTypes),
      group.sourceHost || null,
      group.sourcePort || null
    );

    return group.correlationId;
  }

  async getCorrelatedGroups(options: AnomalyQueryOptions = {}): Promise<StoredCorrelatedGroup[]> {
    if (!this.db) throw new Error('Database not initialized');

    const conditions: string[] = [];
    const params: any[] = [];

    if (options.startTime) {
      conditions.push('timestamp >= ?');
      params.push(options.startTime);
    }
    if (options.endTime) {
      conditions.push('timestamp <= ?');
      params.push(options.endTime);
    }
    if (options.severity) {
      conditions.push('severity = ?');
      params.push(options.severity);
    }
    if (options.pattern) {
      conditions.push('pattern = ?');
      params.push(options.pattern);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    const query = `
      SELECT * FROM correlated_anomaly_groups
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    const rows = this.db.prepare(query).all(...params) as any[];

    return rows.map((row) => this.mappers.mapCorrelatedGroupRow(row));
  }

  async pruneOldCorrelatedGroups(cutoffTimestamp: number): Promise<number> {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.prepare('DELETE FROM correlated_anomaly_groups WHERE timestamp < ?').run(cutoffTimestamp);
    return result.changes;
  }

  async saveKeyPatternSnapshots(snapshots: KeyPatternSnapshot[]): Promise<number> {
    if (!this.db || snapshots.length === 0) return 0;

    const stmt = this.db.prepare(`
      INSERT INTO key_pattern_snapshots (
        id, timestamp, pattern, key_count, sampled_key_count,
        keys_with_ttl, keys_expiring_soon, total_memory_bytes,
        avg_memory_bytes, max_memory_bytes, avg_access_frequency,
        hot_key_count, cold_key_count, avg_idle_time_seconds,
        stale_key_count, avg_ttl_seconds, min_ttl_seconds, max_ttl_seconds
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((snapshots: KeyPatternSnapshot[]) => {
      for (const snapshot of snapshots) {
        stmt.run(
          snapshot.id,
          snapshot.timestamp,
          snapshot.pattern,
          snapshot.keyCount,
          snapshot.sampledKeyCount,
          snapshot.keysWithTtl,
          snapshot.keysExpiringSoon,
          snapshot.totalMemoryBytes,
          snapshot.avgMemoryBytes,
          snapshot.maxMemoryBytes,
          snapshot.avgAccessFrequency ?? null,
          snapshot.hotKeyCount ?? null,
          snapshot.coldKeyCount ?? null,
          snapshot.avgIdleTimeSeconds ?? null,
          snapshot.staleKeyCount ?? null,
          snapshot.avgTtlSeconds ?? null,
          snapshot.minTtlSeconds ?? null,
          snapshot.maxTtlSeconds ?? null,
        );
      }
    });

    insertMany(snapshots);
    return snapshots.length;
  }

  async getKeyPatternSnapshots(options: KeyPatternQueryOptions = {}): Promise<KeyPatternSnapshot[]> {
    if (!this.db) throw new Error('Database not initialized');

    const conditions: string[] = [];
    const params: any[] = [];

    if (options.startTime) {
      conditions.push('timestamp >= ?');
      params.push(options.startTime);
    }
    if (options.endTime) {
      conditions.push('timestamp <= ?');
      params.push(options.endTime);
    }
    if (options.pattern) {
      conditions.push('pattern = ?');
      params.push(options.pattern);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const query = `
      SELECT * FROM key_pattern_snapshots
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    const rows = this.db.prepare(query).all(...params) as any[];

    return rows.map((row) => this.mappers.mapKeyPatternSnapshotRow(row));
  }

  async getKeyAnalyticsSummary(startTime?: number, endTime?: number): Promise<KeyAnalyticsSummary | null> {
    if (!this.db) throw new Error('Database not initialized');

    const conditions: string[] = [];
    const params: number[] = [];

    if (startTime) {
      conditions.push('timestamp >= ?');
      params.push(startTime);
    }
    if (endTime) {
      conditions.push('timestamp <= ?');
      params.push(endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get the latest snapshot for each pattern within the time range
    const latestSnapshotsQuery = `
      SELECT
        pattern,
        MAX(timestamp) as latest_timestamp
      FROM key_pattern_snapshots
      ${whereClause}
      GROUP BY pattern
    `;

    const latestSnapshots = this.db.prepare(latestSnapshotsQuery).all(...params) as Array<{
      pattern: string;
      latest_timestamp: number;
    }>;

    if (latestSnapshots.length === 0) {
      return null;
    }

    // Build aggregation query for latest snapshots only
    const patternConditions = latestSnapshots.map(() => '(pattern = ? AND timestamp = ?)').join(' OR ');
    const patternParams: any[] = [];
    for (const snapshot of latestSnapshots) {
      patternParams.push(snapshot.pattern, snapshot.latest_timestamp);
    }

    const summaryQuery = `
      SELECT
        COUNT(DISTINCT pattern) as total_patterns,
        SUM(key_count) as total_keys,
        SUM(total_memory_bytes) as total_memory_bytes,
        SUM(stale_key_count) as stale_key_count,
        SUM(hot_key_count) as hot_key_count,
        SUM(cold_key_count) as cold_key_count,
        SUM(keys_expiring_soon) as keys_expiring_soon
      FROM key_pattern_snapshots
      WHERE ${patternConditions}
    `;

    const summary = this.db.prepare(summaryQuery).get(...patternParams) as any;

    // Get per-pattern breakdown
    const byPatternQuery = `
      SELECT
        pattern,
        key_count,
        total_memory_bytes,
        avg_memory_bytes,
        stale_key_count,
        hot_key_count,
        cold_key_count
      FROM key_pattern_snapshots
      WHERE ${patternConditions}
    `;

    const patternRows = this.db.prepare(byPatternQuery).all(...patternParams) as any[];

    const byPattern: Record<string, any> = {};
    for (const row of patternRows) {
      byPattern[row.pattern] = {
        keyCount: row.key_count,
        memoryBytes: row.total_memory_bytes,
        avgMemoryBytes: row.avg_memory_bytes,
        staleCount: row.stale_key_count ?? 0,
        hotCount: row.hot_key_count ?? 0,
        coldCount: row.cold_key_count ?? 0,
      };
    }

    // Get time range
    const timeRangeResult = this.db
      .prepare(`SELECT MIN(timestamp) as earliest, MAX(timestamp) as latest FROM key_pattern_snapshots ${whereClause}`)
      .get(...params) as { earliest: number | null; latest: number | null };

    const timeRange =
      timeRangeResult.earliest !== null && timeRangeResult.latest !== null
        ? { earliest: timeRangeResult.earliest, latest: timeRangeResult.latest }
        : null;

    return {
      totalPatterns: summary.total_patterns ?? 0,
      totalKeys: summary.total_keys ?? 0,
      totalMemoryBytes: summary.total_memory_bytes ?? 0,
      staleKeyCount: summary.stale_key_count ?? 0,
      hotKeyCount: summary.hot_key_count ?? 0,
      coldKeyCount: summary.cold_key_count ?? 0,
      keysExpiringSoon: summary.keys_expiring_soon ?? 0,
      byPattern,
      timeRange,
    };
  }

  async getKeyPatternTrends(pattern: string, startTime: number, endTime: number): Promise<Array<{
    timestamp: number;
    keyCount: number;
    memoryBytes: number;
    staleCount: number;
  }>> {
    if (!this.db) throw new Error('Database not initialized');

    const query = `
      SELECT
        timestamp,
        key_count,
        total_memory_bytes,
        stale_key_count
      FROM key_pattern_snapshots
      WHERE pattern = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
    `;

    const rows = this.db.prepare(query).all(pattern, startTime, endTime) as any[];

    return rows.map(row => ({
      timestamp: row.timestamp,
      keyCount: row.key_count,
      memoryBytes: row.total_memory_bytes,
      staleCount: row.stale_key_count ?? 0,
    }));
  }

  async pruneOldKeyPatternSnapshots(cutoffTimestamp: number): Promise<number> {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.prepare('DELETE FROM key_pattern_snapshots WHERE timestamp < ?').run(cutoffTimestamp);
    return result.changes;
  }

  async getSettings(): Promise<AppSettings | null> {
    if (!this.db) throw new Error('Database not initialized');

    const row = this.db.prepare('SELECT * FROM app_settings WHERE id = 1').get() as any;

    if (!row) {
      return null;
    }

    return this.mappers.mapSettingsRow(row);
  }

  async saveSettings(settings: AppSettings): Promise<AppSettings> {
    if (!this.db) throw new Error('Database not initialized');

    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO app_settings (
        id, audit_poll_interval_ms, client_analytics_poll_interval_ms,
        anomaly_poll_interval_ms, anomaly_cache_ttl_ms, anomaly_prometheus_interval_ms,
        updated_at, created_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        audit_poll_interval_ms = excluded.audit_poll_interval_ms,
        client_analytics_poll_interval_ms = excluded.client_analytics_poll_interval_ms,
        anomaly_poll_interval_ms = excluded.anomaly_poll_interval_ms,
        anomaly_cache_ttl_ms = excluded.anomaly_cache_ttl_ms,
        anomaly_prometheus_interval_ms = excluded.anomaly_prometheus_interval_ms,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      settings.auditPollIntervalMs,
      settings.clientAnalyticsPollIntervalMs,
      settings.anomalyPollIntervalMs,
      settings.anomalyCacheTtlMs,
      settings.anomalyPrometheusIntervalMs,
      now,
      settings.createdAt || now
    );

    const saved = await this.getSettings();
    if (!saved) {
      throw new Error('Failed to save settings');
    }
    return saved;
  }

  async updateSettings(updates: SettingsUpdateRequest): Promise<AppSettings> {
    if (!this.db) throw new Error('Database not initialized');

    const current = await this.getSettings();
    if (!current) {
      throw new Error('Settings not found. Initialize settings first.');
    }

    const merged: AppSettings = {
      ...current,
      ...updates,
      updatedAt: Date.now(),
    };

    return this.saveSettings(merged);
  }

  async createWebhook(webhook: Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>): Promise<Webhook> {
    if (!this.db) throw new Error('Database not initialized');

    const id = randomUUID();
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO webhooks (id, name, url, secret, enabled, events, headers, retry_policy, delivery_config, alert_config, thresholds, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      webhook.name,
      webhook.url,
      webhook.secret,
      webhook.enabled ? 1 : 0,
      JSON.stringify(webhook.events),
      JSON.stringify(webhook.headers || {}),
      JSON.stringify(webhook.retryPolicy),
      webhook.deliveryConfig ? JSON.stringify(webhook.deliveryConfig) : null,
      webhook.alertConfig ? JSON.stringify(webhook.alertConfig) : null,
      webhook.thresholds ? JSON.stringify(webhook.thresholds) : null,
      now,
      now
    );

    return {
      id,
      name: webhook.name,
      url: webhook.url,
      secret: webhook.secret,
      enabled: webhook.enabled,
      events: webhook.events,
      headers: webhook.headers,
      retryPolicy: webhook.retryPolicy,
      deliveryConfig: webhook.deliveryConfig,
      alertConfig: webhook.alertConfig,
      thresholds: webhook.thresholds,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getWebhook(id: string): Promise<Webhook | null> {
    if (!this.db) throw new Error('Database not initialized');

    const row = this.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as any;
    if (!row) return null;

    return this.mappers.mapWebhookRow(row);
  }

  async getWebhooksByInstance(): Promise<Webhook[]> {
    if (!this.db) throw new Error('Database not initialized');

    const rows = this.db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all() as any[];
    return rows.map((row) => this.mappers.mapWebhookRow(row));
  }

  async getWebhooksByEvent(event: WebhookEventType): Promise<Webhook[]> {
    if (!this.db) throw new Error('Database not initialized');

    const rows = this.db.prepare('SELECT * FROM webhooks WHERE enabled = 1').all() as any[];
    return rows
      .map((row) => this.mappers.mapWebhookRow(row))
      .filter((webhook) => webhook.events.includes(event));
  }

  async updateWebhook(id: string, updates: Partial<Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Webhook | null> {
    if (!this.db) throw new Error('Database not initialized');

    const setClauses: string[] = [];
    const params: any[] = [];

    if (updates.name !== undefined) {
      setClauses.push('name = ?');
      params.push(updates.name);
    }
    if (updates.url !== undefined) {
      setClauses.push('url = ?');
      params.push(updates.url);
    }
    if (updates.secret !== undefined) {
      setClauses.push('secret = ?');
      params.push(updates.secret);
    }
    if (updates.enabled !== undefined) {
      setClauses.push('enabled = ?');
      params.push(updates.enabled ? 1 : 0);
    }
    if (updates.events !== undefined) {
      setClauses.push('events = ?');
      params.push(JSON.stringify(updates.events));
    }
    if (updates.headers !== undefined) {
      setClauses.push('headers = ?');
      params.push(JSON.stringify(updates.headers));
    }
    if (updates.retryPolicy !== undefined) {
      setClauses.push('retry_policy = ?');
      params.push(JSON.stringify(updates.retryPolicy));
    }
    if (updates.deliveryConfig !== undefined) {
      setClauses.push('delivery_config = ?');
      params.push(JSON.stringify(updates.deliveryConfig));
    }
    if (updates.alertConfig !== undefined) {
      setClauses.push('alert_config = ?');
      params.push(JSON.stringify(updates.alertConfig));
    }
    if (updates.thresholds !== undefined) {
      setClauses.push('thresholds = ?');
      params.push(JSON.stringify(updates.thresholds));
    }

    if (setClauses.length === 0) {
      return this.getWebhook(id);
    }

    setClauses.push('updated_at = ?');
    params.push(Date.now());
    params.push(id);

    const stmt = this.db.prepare(`UPDATE webhooks SET ${setClauses.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);

    if (result.changes === 0) return null;
    return this.getWebhook(id);
  }

  async deleteWebhook(id: string): Promise<boolean> {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
    return result.changes > 0;
  }

  async createDelivery(delivery: Omit<WebhookDelivery, 'id' | 'createdAt'>): Promise<WebhookDelivery> {
    if (!this.db) throw new Error('Database not initialized');

    const id = randomUUID();
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO webhook_deliveries (
        id, webhook_id, event_type, payload, status, status_code, response_body,
        attempts, next_retry_at, completed_at, duration_ms, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      delivery.webhookId,
      delivery.eventType,
      JSON.stringify(delivery.payload),
      delivery.status,
      delivery.statusCode || null,
      delivery.responseBody || null,
      delivery.attempts,
      delivery.nextRetryAt || null,
      delivery.completedAt || null,
      delivery.durationMs || null,
      now
    );

    return {
      id,
      webhookId: delivery.webhookId,
      eventType: delivery.eventType,
      payload: delivery.payload,
      status: delivery.status,
      statusCode: delivery.statusCode,
      responseBody: delivery.responseBody,
      attempts: delivery.attempts,
      nextRetryAt: delivery.nextRetryAt,
      createdAt: now,
      completedAt: delivery.completedAt,
      durationMs: delivery.durationMs,
    };
  }

  async getDelivery(id: string): Promise<WebhookDelivery | null> {
    if (!this.db) throw new Error('Database not initialized');

    const row = this.db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id) as any;
    if (!row) return null;

    return this.mappers.mapDeliveryRow(row);
  }

  async getDeliveriesByWebhook(webhookId: string, limit: number = 50, offset: number = 0): Promise<WebhookDelivery[]> {
    if (!this.db) throw new Error('Database not initialized');

    const rows = this.db.prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(webhookId, limit, offset) as any[];

    return rows.map((row) => this.mappers.mapDeliveryRow(row));
  }

  async updateDelivery(id: string, updates: Partial<Omit<WebhookDelivery, 'id' | 'webhookId' | 'createdAt'>>): Promise<boolean> {
    if (!this.db) throw new Error('Database not initialized');

    const setClauses: string[] = [];
    const params: any[] = [];

    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      params.push(updates.status);
    }
    if (updates.statusCode !== undefined) {
      setClauses.push('status_code = ?');
      params.push(updates.statusCode);
    }
    if (updates.responseBody !== undefined) {
      setClauses.push('response_body = ?');
      params.push(updates.responseBody);
    }
    if (updates.attempts !== undefined) {
      setClauses.push('attempts = ?');
      params.push(updates.attempts);
    }
    if (updates.nextRetryAt !== undefined) {
      setClauses.push('next_retry_at = ?');
      params.push(updates.nextRetryAt !== undefined ? updates.nextRetryAt : null);
    }
    if (updates.completedAt !== undefined) {
      setClauses.push('completed_at = ?');
      params.push(updates.completedAt !== undefined ? updates.completedAt : null);
    }
    if (updates.durationMs !== undefined) {
      setClauses.push('duration_ms = ?');
      params.push(updates.durationMs);
    }

    if (setClauses.length === 0) return true;

    params.push(id);

    const stmt = this.db.prepare(`UPDATE webhook_deliveries SET ${setClauses.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);

    return result.changes > 0;
  }

  async getRetriableDeliveries(limit: number = 100): Promise<WebhookDelivery[]> {
    if (!this.db) throw new Error('Database not initialized');

    const now = Date.now();
    const rows = this.db.prepare(
      `SELECT * FROM webhook_deliveries
       WHERE status = 'retrying' AND next_retry_at <= ?
       ORDER BY next_retry_at ASC
       LIMIT ?`
    ).all(now, limit) as any[];

    return rows.map((row) => this.mappers.mapDeliveryRow(row));
  }

  async pruneOldDeliveries(cutoffTimestamp: number): Promise<number> {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.prepare('DELETE FROM webhook_deliveries WHERE created_at < ?').run(cutoffTimestamp);
    return result.changes;
  }

  // Slow Log Methods
  async saveSlowLogEntries(entries: StoredSlowLogEntry[]): Promise<number> {
    if (!this.db || entries.length === 0) return 0;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO slow_log_entries (
        slowlog_id, timestamp, duration, command,
        client_address, client_name, captured_at, source_host, source_port
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let count = 0;
    const transaction = this.db.transaction(() => {
      for (const entry of entries) {
        const result = stmt.run(
          entry.id,
          entry.timestamp,
          entry.duration,
          JSON.stringify(entry.command),  // Store as JSON string
          entry.clientAddress || '',
          entry.clientName || '',
          entry.capturedAt,
          entry.sourceHost,
          entry.sourcePort,
        );
        count += result.changes;
      }
    });
    transaction();

    return count;
  }

  async getSlowLogEntries(options: SlowLogQueryOptions = {}): Promise<StoredSlowLogEntry[]> {
    if (!this.db) throw new Error('Database not initialized');

    const conditions: string[] = [];
    const params: any[] = [];

    if (options.startTime) {
      conditions.push('timestamp >= ?');
      params.push(options.startTime);
    }
    if (options.endTime) {
      conditions.push('timestamp <= ?');
      params.push(options.endTime);
    }
    if (options.command) {
      conditions.push('command LIKE ?');
      params.push(`%${options.command}%`);
    }
    if (options.clientName) {
      conditions.push('client_name LIKE ?');
      params.push(`%${options.clientName}%`);
    }
    if (options.minDuration) {
      conditions.push('duration >= ?');
      params.push(options.minDuration);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const rows = this.db.prepare(
      `SELECT slowlog_id, timestamp, duration, command,
              client_address, client_name, captured_at, source_host, source_port
       FROM slow_log_entries
       ${whereClause}
       ORDER BY timestamp DESC
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as any[];

    return rows.map((row) => this.mappers.mapSlowLogEntryRow(row));
  }

  async getLatestSlowLogId(): Promise<number | null> {
    if (!this.db) throw new Error('Database not initialized');

    const row = this.db.prepare('SELECT MAX(slowlog_id) as max_id FROM slow_log_entries').get() as any;
    return row?.max_id ?? null;
  }

  async pruneOldSlowLogEntries(cutoffTimestamp: number): Promise<number> {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.prepare('DELETE FROM slow_log_entries WHERE captured_at < ?').run(cutoffTimestamp);
    return result.changes;
  }

  // Command Log Methods (stub implementations for SQLite)
  async saveCommandLogEntries(entries: StoredCommandLogEntry[]): Promise<number> {
    // SQLite not used for command log persistence in this implementation
    return 0;
  }

  async getCommandLogEntries(options: CommandLogQueryOptions = {}): Promise<StoredCommandLogEntry[]> {
    return [];
  }

  async getLatestCommandLogId(type: CommandLogType): Promise<number | null> {
    return null;
  }

  async pruneOldCommandLogEntries(cutoffTimestamp: number): Promise<number> {
    return 0;
  }
}
