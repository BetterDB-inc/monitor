// SQLite adapter for local development only
// This file is excluded from Docker builds via .dockerignore
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import {
  StoragePort,
  StoredAclEntry,
  AuditQueryOptions,
  AuditStats,
  StoredClientSnapshot,
  ClientSnapshotQueryOptions,
  ClientTimeSeriesPoint,
  ClientAnalyticsStats,
} from '../../common/interfaces/storage-port.interface';

export interface SqliteAdapterConfig {
  filepath: string;
}

export class SqliteAdapter implements StoragePort {
  private db: Database.Database | null = null;
  private ready: boolean = false;

  constructor(private config: SqliteAdapterConfig) {}

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
      this.ready = true;
    } catch (error) {
      this.ready = false;
      throw new Error(`Failed to initialize SQLite: ${error instanceof Error ? error.message : 'Unknown error'}`);
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

    const rows = this.db.prepare(query).all(...params) as Array<{
      id: number;
      count: number;
      reason: string;
      context: string;
      object: string;
      username: string;
      age_seconds: number;
      client_info: string;
      timestamp_created: number;
      timestamp_last_updated: number;
      captured_at: number;
      source_host: string;
      source_port: number;
    }>;

    return rows.map((row) => ({
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
    }));
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

    const rows = this.db.prepare(query).all(...params) as Array<{
      id: number;
      client_id: string;
      addr: string;
      name: string;
      user: string;
      db: number;
      cmd: string;
      age: number;
      idle: number;
      flags: string;
      sub: number;
      psub: number;
      qbuf: number;
      qbuf_free: number;
      obl: number;
      oll: number;
      omem: number;
      captured_at: number;
      source_host: string;
      source_port: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      addr: row.addr,
      name: row.name,
      user: row.user,
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
    }));
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

    const rows = this.db.prepare(query).all(...params) as Array<{
      id: number;
      client_id: string;
      addr: string;
      name: string;
      user: string;
      db: number;
      cmd: string;
      age: number;
      idle: number;
      flags: string;
      sub: number;
      psub: number;
      qbuf: number;
      qbuf_free: number;
      obl: number;
      oll: number;
      omem: number;
      captured_at: number;
      source_host: string;
      source_port: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      addr: row.addr,
      name: row.name,
      user: row.user,
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
    }));
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
    `);
  }
}
