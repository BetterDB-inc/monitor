import { Pool, PoolConfig } from 'pg';
import { randomUUID } from 'crypto';
import {
  AnomalyQueryOptions,
  AnomalyStats,
  AppSettings,
  AuditQueryOptions,
  AuditStats,
  ClientAnalyticsStats,
  ClientSnapshotQueryOptions,
  ClientTimeSeriesPoint,
  CommandLogQueryOptions,
  CommandLogType,
  CommandStatsHistoryQueryOptions,
  DatabaseConnectionConfig,
  HotKeyEntry,
  HotKeyQueryOptions,
  KeyAnalyticsSummary,
  KeyPatternQueryOptions,
  KeyPatternSnapshot,
  LatencySnapshotQueryOptions,
  MemorySnapshotQueryOptions,
  SettingsUpdateRequest,
  SlowLogQueryOptions,
  StoragePort,
  StoredAclEntry,
  StoredAnomalyEvent,
  StoredBulkDeleteAudit,
  BulkDeleteAuditQueryOptions,
  StoredClientSnapshot,
  StoredCommandLogEntry,
  StoredCommandStatsSample,
  StoredLatencyStatsSample,
  LatencyStatsHistoryQueryOptions,
  StoredAiCacheSample,
  AiCacheHistoryQueryOptions,
  StoredOtelSpan,
  OtelTraceSummary,
  OtelTraceQueryOptions,
  StoredCorrelatedGroup,
  StoredLatencyHistogram,
  StoredLatencySnapshot,
  StoredMemorySnapshot,
  StoredSlowLogEntry,
  Webhook,
  WebhookDelivery,
  WebhookEventType,
  StoredCaptureSession,
  CaptureSessionQueryOptions,
  StoredCaptureChunk,
  CaptureSessionPatch,
  StoredCaptureTrigger,
  CaptureTriggerQueryOptions,
  CaptureTriggerPatch,
  StoredScheduledCapture,
  ScheduledCaptureQueryOptions,
  ScheduledCapturePatch,
} from '../../common/interfaces/storage-port.interface';
import type {
  ActorSource,
  AppendProposalAuditInput,
  AppliedResult,
  CacheType,
  CreateCacheProposalInput,
  ListCacheProposalsOptions,
  MetricForecastSettings,
  MetricKind,
  ProposalAuditEvent,
  ProposalPayload,
  ProposalStatus,
  ProposalType,
  StoredCacheProposal,
  StoredCacheProposalAudit,
  UpdateProposalStatusInput,
  VectorIndexSnapshot,
  VectorIndexSnapshotQueryOptions,
} from '@betterdb/shared';
import {
  PROPOSAL_DEFAULT_EXPIRY_MS,
  StoredCacheProposalSchema,
  StoredCacheProposalAuditSchema,
  variantPayloadSchemaFor,
  MEMORY_PROPOSAL_DEFAULT_EXPIRY_MS,
  StoredMemoryProposalSchema,
  StoredMemoryProposalAuditSchema,
} from '@betterdb/shared';
import type {
  StoredMemoryProposal,
  StoredMemoryProposalAudit,
  CreateMemoryProposalInput,
  ListMemoryProposalsOptions,
  UpdateMemoryProposalStatusInput,
  AppendMemoryProposalAuditInput,
} from '@betterdb/shared';
import { PostgresDialect, RowMappers } from './base-sql.adapter';
import { WebhookPostgresRepository } from './repositories/webhook.postgres.repository';
import { SlowLogPostgresRepository } from './repositories/slowlog.postgres.repository';

// Domain-specific repositories (webhooks, slowlog extracted). Remaining domains to extract:
// ACL, anomaly, commandlog, latency, memory, hotkeys, settings,
// agent-tokens, metric-forecasts, client-snapshots, key-patterns, vector-index-snapshots.

export interface PostgresAdapterConfig {
  connectionString: string;
  schema?: string; // PostgreSQL schema for tenant isolation
}

type PgNumeric = string | number;
type PgJsonb<T> = T | string;

interface CacheProposalRow {
  id: string;
  connection_id: string;
  cache_name: string;
  cache_type: CacheType;
  proposal_type: ProposalType;
  proposal_payload: PgJsonb<ProposalPayload>;
  reasoning: string | null;
  status: ProposalStatus;
  proposed_by: string | null;
  proposed_at: PgNumeric;
  reviewed_by: string | null;
  reviewed_at: PgNumeric | null;
  applied_at: PgNumeric | null;
  applied_result: PgJsonb<AppliedResult> | null;
  expires_at: PgNumeric;
}

interface CacheProposalAuditRow {
  id: string;
  proposal_id: string;
  event_type: ProposalAuditEvent;
  event_payload: PgJsonb<Record<string, unknown>> | null;
  event_at: PgNumeric;
  actor: string | null;
  actor_source: ActorSource;
}

interface MemoryProposalRow {
  id: string;
  connection_id: string;
  store_name: string;
  proposal_type: 'forget';
  proposal_payload: PgJsonb<Record<string, unknown>>;
  reasoning: string | null;
  status: ProposalStatus;
  proposed_by: string | null;
  proposed_at: PgNumeric;
  reviewed_by: string | null;
  reviewed_at: PgNumeric | null;
  applied_at: PgNumeric | null;
  applied_result: PgJsonb<AppliedResult> | null;
  expires_at: PgNumeric;
}

interface MemoryProposalAuditRow {
  id: string;
  proposal_id: string;
  event_type: ProposalAuditEvent;
  event_payload: PgJsonb<Record<string, unknown>> | null;
  event_at: PgNumeric;
  actor: string | null;
  actor_source: ActorSource;
}

export class PostgresAdapter implements StoragePort {
  private pool: Pool | null = null;
  private ready: boolean = false;
  private readonly mappers = new RowMappers(PostgresDialect);
  private webhookRepo!: WebhookPostgresRepository;
  private slowlogRepo!: SlowLogPostgresRepository;

  constructor(private config: PostgresAdapterConfig) {}

  async initialize(): Promise<void> {
    try {
      // Issue #11: Properly type poolConfig instead of using 'any'
      const poolConfig: PoolConfig = {
        connectionString: this.config.connectionString,
      };

      // Enable SSL if STORAGE_SSL_CA is set (URL or file path)
      const sslCa = process.env.STORAGE_SSL_CA;

      if (sslCa) {
        let ca: string;

        // Issue #3: Add security validation for SSL CA URLs
        // Only allow HTTPS to prevent man-in-the-middle attacks on CA certificate fetching
        if (sslCa.startsWith('http://')) {
          throw new Error(
            'Fetching SSL CA certificate over insecure HTTP is not allowed. ' +
              'Use HTTPS or provide a local file path instead.',
          );
        }

        if (sslCa.startsWith('https://')) {
          // Whitelist of trusted domains for official SSL certificate authorities
          // Only specific official certificate distribution endpoints, not general cloud storage
          const trustedDomains = [
            'truststore.pki.rds.amazonaws.com', // AWS RDS official CA bundle
            'storage.googleapis.com/cloud-sql-ca', // GCP Cloud SQL official path (must check full path)
            'dl.cacerts.digicert.com', // DigiCert CA certificates (used by Azure)
            'cacerts.digicert.com', // DigiCert CA certificates alternate
          ];

          const url = new URL(sslCa);

          // Check domain with proper boundary to prevent subdomain spoofing
          // For path-specific validation (like GCS), also check the path
          const isTrustedDomain = trustedDomains.some((domain) => {
            // Exact hostname match
            if (url.hostname === domain) {
              return true;
            }

            // Subdomain match (e.g., subdomain.trusted.com matches trusted.com)
            if (url.hostname.endsWith('.' + domain)) {
              return true;
            }

            // Special case for GCS: must have specific path prefix with trailing slash
            // This prevents /cloud-sql-ca-evil/ from matching
            if (domain === 'storage.googleapis.com/cloud-sql-ca') {
              return (
                url.hostname === 'storage.googleapis.com' &&
                url.pathname.startsWith('/cloud-sql-ca/')
              );
            }

            return false;
          });

          if (!isTrustedDomain) {
            throw new Error(
              `SSL certificate fetching blocked: ${url.hostname} is not in the trusted domains list. ` +
                `Trusted domains: ${trustedDomains.join(', ')}. ` +
                `Use a local file path or a trusted cloud provider URL.`,
            );
          }

          // Issue #8: Add telemetry/logging for SSL operations
          console.log(`Fetching SSL CA bundle from: ${sslCa}`);

          try {
            // Add timeout to fetch and prevent redirect bypass
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

            const response = await fetch(sslCa, {
              signal: controller.signal,
              redirect: 'error', // Prevent redirect bypass of domain whitelist
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
              throw new Error(`Failed to fetch CA bundle from ${sslCa}: ${response.status}`);
            }
            ca = await response.text();
            console.log('Successfully fetched SSL CA bundle');
          } catch (fetchError) {
            // Issue #8: Log SSL errors for debugging
            const errorMsg = fetchError instanceof Error ? fetchError.message : 'Unknown error';
            console.error(`Failed to fetch SSL CA bundle: ${errorMsg}`);
            throw new Error(`Failed to fetch SSL CA bundle from ${sslCa}: ${errorMsg}`);
          }
        } else {
          // Read from file path
          console.log(`Reading SSL CA bundle from file: ${sslCa}`);
          const fs = await import('fs');
          try {
            ca = fs.readFileSync(sslCa, 'utf8');
            console.log('Successfully loaded SSL CA bundle from file');
          } catch (fileError) {
            const errorMsg = fileError instanceof Error ? fileError.message : 'Unknown error';
            console.error(`Failed to read SSL CA file: ${errorMsg}`);
            throw new Error(`Failed to read SSL CA file ${sslCa}: ${errorMsg}`);
          }
        }

        poolConfig.ssl = {
          rejectUnauthorized: true,
          ca,
        };
      }

      this.pool = new Pool(poolConfig);

      const schemaName = this.config.schema;

      if (schemaName) {
        // Validate schema name to prevent SQL injection (defense in depth)
        if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
          throw new Error(`Invalid schema name: ${schemaName}`);
        }

        // Create schema using initial pool (runs in public/default search_path)
        const bootstrapClient = await this.pool.connect();
        await bootstrapClient.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
        bootstrapClient.release();

        // Recreate pool with search_path set on every connection
        await this.pool.end();
        this.pool = new Pool(poolConfig);
        this.pool.on('connect', (client) => {
          client.query(`SET search_path TO ${schemaName}, public`).catch((err: unknown) => {
            console.error(`Failed to set search_path for schema ${schemaName}:`, err);
          });
        });
      }

      this.webhookRepo = new WebhookPostgresRepository(this.pool, this.mappers);
      this.slowlogRepo = new SlowLogPostgresRepository(this.pool, this.mappers);

      // Test connection (will have correct search_path if schema is set)
      const testClient = await this.pool.connect();
      testClient.release();

      // Issue #9: Restore explanatory comments for migration order
      // Run migrations FIRST to add connection_id to existing tables.
      // This must happen before createSchema() which creates indexes on connection_id.
      await this.migrateConnectionId();
      await this.createSchema();

      this.ready = true;

      if (schemaName) {
        console.log(`PostgreSQL initialized with schema: ${schemaName}`);
      }
    } catch (error) {
      this.ready = false;
      throw new Error(
        `Failed to initialize PostgreSQL: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Add connection_id column to all data tables for multi-database support.
   * This migration is idempotent and safe to run multiple times.
   */
  private async migrateConnectionId(): Promise<void> {
    if (!this.pool) return;

    const tables = [
      'acl_audit',
      'client_snapshots',
      'anomaly_events',
      'correlated_anomaly_groups',
      'key_pattern_snapshots',
      'webhooks',
      'webhook_deliveries',
      'slow_log_entries',
      'command_log_entries',
    ];

    for (const table of tables) {
      try {
        // Add connection_id column if it doesn't exist
        await this.pool.query(`
          ALTER TABLE ${table}
          ADD COLUMN IF NOT EXISTS connection_id TEXT DEFAULT 'env-default'
        `);

        // Create index on connection_id
        await this.pool.query(`
          CREATE INDEX IF NOT EXISTS idx_${table}_connection_id
          ON ${table}(connection_id)
        `);
      } catch (error) {
        // Ignore errors - column/index might already exist in older PG versions
      }
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.ready = false;
    }
  }

  isReady(): boolean {
    return this.ready && this.pool !== null;
  }

  async saveAclEntries(entries: StoredAclEntry[], connectionId: string): Promise<number> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    if (entries.length === 0) {
      return 0;
    }

    const values: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    for (const entry of entries) {
      values.push(
        `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7}, $${paramIndex + 8}, $${paramIndex + 9}, $${paramIndex + 10}, $${paramIndex + 11}, $${paramIndex + 12})`,
      );
      params.push(
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
        connectionId,
      );
      paramIndex += 13;
    }

    const query = `
      INSERT INTO acl_audit (
        count, reason, context, object, username, age_seconds, client_info,
        timestamp_created, timestamp_last_updated, captured_at, source_host, source_port, connection_id
      ) VALUES ${values.join(', ')}
      ON CONFLICT (timestamp_created, username, object, reason, source_host, source_port, connection_id)
      DO UPDATE SET
        count = EXCLUDED.count,
        age_seconds = EXCLUDED.age_seconds,
        timestamp_last_updated = EXCLUDED.timestamp_last_updated,
        captured_at = EXCLUDED.captured_at
    `;

    await this.pool.query(query, params);
    return entries.length;
  }

  async getAclEntries(options: AuditQueryOptions = {}): Promise<StoredAclEntry[]> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIndex = 1;

    if (options.connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(options.connectionId);
    }

    if (options.username) {
      conditions.push(`username = $${paramIndex++}`);
      params.push(options.username);
    }

    if (options.reason) {
      conditions.push(`reason = $${paramIndex++}`);
      params.push(options.reason);
    }

    if (options.startTime) {
      conditions.push(`captured_at >= $${paramIndex++}`);
      params.push(options.startTime);
    }

    if (options.endTime) {
      conditions.push(`captured_at <= $${paramIndex++}`);
      params.push(options.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const query = `
      SELECT * FROM acl_audit
      ${whereClause}
      ORDER BY captured_at DESC, id DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(limit, offset);

    const result = await this.pool.query(query, params);
    return result.rows.map((row) => this.mappers.mapAclEntryRow(row));
  }

  async getAuditStats(
    startTime?: number,
    endTime?: number,
    connectionId?: string,
  ): Promise<AuditStats> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    const conditions: string[] = [];
    const params: (number | string)[] = [];
    let paramIndex = 1;

    if (connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(connectionId);
    }

    if (startTime) {
      conditions.push(`captured_at >= $${paramIndex++}`);
      params.push(startTime);
    }

    if (endTime) {
      conditions.push(`captured_at <= $${paramIndex++}`);
      params.push(endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const totalResult = await this.pool.query(
      `SELECT COUNT(*) as count FROM acl_audit ${whereClause}`,
      params,
    );

    const uniqueUsersResult = await this.pool.query(
      `SELECT COUNT(DISTINCT username) as count FROM acl_audit ${whereClause}`,
      params,
    );

    const byReasonResult = await this.pool.query(
      `SELECT reason, COUNT(*) as count FROM acl_audit ${whereClause} GROUP BY reason`,
      params,
    );

    const byUserResult = await this.pool.query(
      `SELECT username, COUNT(*) as count FROM acl_audit ${whereClause} GROUP BY username`,
      params,
    );

    const timeRangeResult = await this.pool.query(
      `SELECT MIN(captured_at) as earliest, MAX(captured_at) as latest FROM acl_audit ${whereClause}`,
      params,
    );

    const entriesByReason: Record<string, number> = {};
    for (const row of byReasonResult.rows) {
      entriesByReason[row.reason] = parseInt(row.count);
    }

    const entriesByUser: Record<string, number> = {};
    for (const row of byUserResult.rows) {
      entriesByUser[row.username] = parseInt(row.count);
    }

    const timeRange =
      timeRangeResult.rows[0].earliest !== null && timeRangeResult.rows[0].latest !== null
        ? {
            earliest: parseInt(timeRangeResult.rows[0].earliest),
            latest: parseInt(timeRangeResult.rows[0].latest),
          }
        : null;

    return {
      totalEntries: parseInt(totalResult.rows[0].count),
      uniqueUsers: parseInt(uniqueUsersResult.rows[0].count),
      entriesByReason,
      entriesByUser,
      timeRange,
    };
  }

  async pruneOldEntries(olderThanTimestamp: number, connectionId?: string): Promise<number> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM acl_audit WHERE captured_at < $1 AND connection_id = $2',
        [olderThanTimestamp, connectionId],
      );
      return result.rowCount || 0;
    }

    const result = await this.pool.query('DELETE FROM acl_audit WHERE captured_at < $1', [
      olderThanTimestamp,
    ]);

    return result.rowCount || 0;
  }

  async saveClientSnapshot(clients: StoredClientSnapshot[], connectionId: string): Promise<number> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    if (clients.length === 0) {
      return 0;
    }

    const values: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    for (const client of clients) {
      values.push(
        `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7}, $${paramIndex + 8}, $${paramIndex + 9}, $${paramIndex + 10}, $${paramIndex + 11}, $${paramIndex + 12}, $${paramIndex + 13}, $${paramIndex + 14}, $${paramIndex + 15}, $${paramIndex + 16}, $${paramIndex + 17}, $${paramIndex + 18}, $${paramIndex + 19})`,
      );
      params.push(
        client.clientId,
        client.addr,
        client.name || null,
        client.user || null,
        client.db,
        client.cmd || null,
        client.age,
        client.idle,
        client.flags || null,
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
        connectionId,
      );
      paramIndex += 20;
    }

    const query = `
      INSERT INTO client_snapshots (
        client_id, addr, name, user_name, db, cmd, age, idle, flags,
        sub, psub, qbuf, qbuf_free, obl, oll, omem,
        captured_at, source_host, source_port, connection_id
      ) VALUES ${values.join(', ')}
    `;

    await this.pool.query(query, params);
    return clients.length;
  }

  async getClientSnapshots(
    options: ClientSnapshotQueryOptions = {},
  ): Promise<StoredClientSnapshot[]> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIndex = 1;

    if (options.connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(options.connectionId);
    }

    if (options.clientName) {
      conditions.push(`name = $${paramIndex++}`);
      params.push(options.clientName);
    }

    if (options.user) {
      conditions.push(`user_name = $${paramIndex++}`);
      params.push(options.user);
    }

    if (options.addr) {
      if (options.addr.includes('%')) {
        conditions.push(`addr LIKE $${paramIndex++}`);
      } else {
        conditions.push(`addr = $${paramIndex++}`);
      }
      params.push(options.addr);
    }

    if (options.startTime) {
      conditions.push(`captured_at >= $${paramIndex++}`);
      params.push(options.startTime);
    }

    if (options.endTime) {
      conditions.push(`captured_at <= $${paramIndex++}`);
      params.push(options.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const query = `
      SELECT * FROM client_snapshots
      ${whereClause}
      ORDER BY captured_at DESC, id DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(limit, offset);

    const result = await this.pool.query(query, params);
    return result.rows.map((row) => this.mappers.mapClientRow(row));
  }

  async getClientTimeSeries(
    startTime: number,
    endTime: number,
    bucketSizeMs: number = 60000,
    connectionId?: string,
  ): Promise<ClientTimeSeriesPoint[]> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    const conditions = ['captured_at >= $2', 'captured_at <= $3'];
    const params: any[] = [bucketSizeMs, startTime, endTime];

    if (connectionId) {
      conditions.push(`connection_id = $4`);
      params.push(connectionId);
    }

    const query = `
      SELECT
        (captured_at / $1 * $1) as bucket_time,
        COUNT(*) as total_connections,
        name,
        user_name,
        addr
      FROM client_snapshots
      WHERE ${conditions.join(' AND ')}
      GROUP BY bucket_time, name, user_name, addr
      ORDER BY bucket_time
    `;

    const result = await this.pool.query(query, params);

    const pointsMap = new Map<number, ClientTimeSeriesPoint>();

    for (const row of result.rows) {
      const bucketTime = parseInt(row.bucket_time);
      if (!pointsMap.has(bucketTime)) {
        pointsMap.set(bucketTime, {
          timestamp: bucketTime,
          totalConnections: 0,
          byName: {},
          byUser: {},
          byAddr: {},
        });
      }

      const point = pointsMap.get(bucketTime)!;
      point.totalConnections += parseInt(row.total_connections);

      if (row.name) {
        point.byName[row.name] = (point.byName[row.name] || 0) + 1;
      }
      if (row.user_name) {
        point.byUser[row.user_name] = (point.byUser[row.user_name] || 0) + 1;
      }
      const ip = row.addr.split(':')[0];
      point.byAddr[ip] = (point.byAddr[ip] || 0) + 1;
    }

    return Array.from(pointsMap.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  async getClientAnalyticsStats(
    startTime?: number,
    endTime?: number,
    connectionId?: string,
  ): Promise<ClientAnalyticsStats> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    const conditions: string[] = [];
    const params: (number | string)[] = [];
    let paramIndex = 1;

    if (connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(connectionId);
    }

    if (startTime) {
      conditions.push(`captured_at >= $${paramIndex++}`);
      params.push(startTime);
    }

    if (endTime) {
      conditions.push(`captured_at <= $${paramIndex++}`);
      params.push(endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get latest timestamp
    const latestResult = await this.pool.query(
      `SELECT MAX(captured_at) as latest FROM client_snapshots ${whereClause}`,
      params,
    );
    const latestTimestamp = latestResult.rows[0].latest;

    const currentConditions = latestTimestamp
      ? [...conditions, `captured_at = $${paramIndex++}`]
      : conditions;
    const currentParams = latestTimestamp ? [...params, latestTimestamp] : params;
    const currentWhereClause =
      currentConditions.length > 0 ? `WHERE ${currentConditions.join(' AND ')}` : '';

    const currentConnectionsResult = await this.pool.query(
      `SELECT COUNT(*) as count FROM client_snapshots ${currentWhereClause}`,
      currentParams,
    );

    const peakResult = await this.pool.query(
      `
      SELECT captured_at, COUNT(*) as count
      FROM client_snapshots ${whereClause}
      GROUP BY captured_at
      ORDER BY count DESC
      LIMIT 1
    `,
      params,
    );

    const uniqueStatsResult = await this.pool.query(
      `
      SELECT
        COUNT(DISTINCT name) as unique_names,
        COUNT(DISTINCT user_name) as unique_users,
        COUNT(DISTINCT SPLIT_PART(addr, ':', 1)) as unique_ips
      FROM client_snapshots ${whereClause}
    `,
      params,
    );

    // Connections by name
    const byNameResult = await this.pool.query(
      `
      SELECT name, COUNT(*) as total, AVG(age) as avg_age
      FROM client_snapshots ${whereClause}
      GROUP BY name
    `,
      params,
    );

    const connectionsByName: Record<string, { current: number; peak: number; avgAge: number }> = {};

    for (const row of byNameResult.rows) {
      if (row.name) {
        const namePeakParams = [...params, row.name];
        const namePeakResult = await this.pool.query(
          `
          SELECT COUNT(*) as count
          FROM client_snapshots
          WHERE name = $${params.length + 1} ${whereClause ? 'AND ' + whereClause.substring(6) : ''}
          GROUP BY captured_at
          ORDER BY count DESC
          LIMIT 1
        `,
          namePeakParams,
        );

        const nameCurrentParams = [...currentParams, row.name];
        const nameCurrentResult = await this.pool.query(
          `
          SELECT COUNT(*) as count
          FROM client_snapshots
          WHERE name = $${currentParams.length + 1} ${currentWhereClause ? 'AND ' + currentWhereClause.substring(6) : ''}
        `,
          nameCurrentParams,
        );

        connectionsByName[row.name] = {
          current: parseInt(nameCurrentResult.rows[0]?.count || '0'),
          peak: parseInt(namePeakResult.rows[0]?.count || '0'),
          avgAge: parseFloat(row.avg_age),
        };
      }
    }

    // Connections by user
    const byUserResult = await this.pool.query(
      `SELECT user_name, COUNT(*) as total FROM client_snapshots ${whereClause} GROUP BY user_name`,
      params,
    );

    const connectionsByUser: Record<string, { current: number; peak: number }> = {};

    for (const row of byUserResult.rows) {
      if (row.user_name) {
        const userPeakParams = [...params, row.user_name];
        const userPeakResult = await this.pool.query(
          `
          SELECT COUNT(*) as count
          FROM client_snapshots
          WHERE user_name = $${params.length + 1} ${whereClause ? 'AND ' + whereClause.substring(6) : ''}
          GROUP BY captured_at
          ORDER BY count DESC
          LIMIT 1
        `,
          userPeakParams,
        );

        const userCurrentParams = [...currentParams, row.user_name];
        const userCurrentResult = await this.pool.query(
          `
          SELECT COUNT(*) as count
          FROM client_snapshots
          WHERE user_name = $${currentParams.length + 1} ${currentWhereClause ? 'AND ' + currentWhereClause.substring(6) : ''}
        `,
          userCurrentParams,
        );

        connectionsByUser[row.user_name] = {
          current: parseInt(userCurrentResult.rows[0]?.count || '0'),
          peak: parseInt(userPeakResult.rows[0]?.count || '0'),
        };
      }
    }

    // Connections by user and name
    const byUserAndNameResult = await this.pool.query(
      `
      SELECT user_name, name, COUNT(*) as total, AVG(age) as avg_age
      FROM client_snapshots ${whereClause}
      GROUP BY user_name, name
    `,
      params,
    );

    const connectionsByUserAndName: Record<
      string,
      { user: string; name: string; current: number; peak: number; avgAge: number }
    > = {};

    for (const row of byUserAndNameResult.rows) {
      const key = `${row.user_name}:${row.name}`;

      const combinedPeakParams = [...params, row.user_name, row.name];
      const combinedPeakResult = await this.pool.query(
        `
        SELECT COUNT(*) as count
        FROM client_snapshots
        WHERE user_name = $${params.length + 1} AND name = $${params.length + 2} ${whereClause ? 'AND ' + whereClause.substring(6) : ''}
        GROUP BY captured_at
        ORDER BY count DESC
        LIMIT 1
      `,
        combinedPeakParams,
      );

      const combinedCurrentParams = [...currentParams, row.user_name, row.name];
      const combinedCurrentResult = await this.pool.query(
        `
        SELECT COUNT(*) as count
        FROM client_snapshots
        WHERE user_name = $${currentParams.length + 1} AND name = $${currentParams.length + 2} ${currentWhereClause ? 'AND ' + currentWhereClause.substring(6) : ''}
      `,
        combinedCurrentParams,
      );

      connectionsByUserAndName[key] = {
        user: row.user_name,
        name: row.name,
        current: parseInt(combinedCurrentResult.rows[0]?.count || '0'),
        peak: parseInt(combinedPeakResult.rows[0]?.count || '0'),
        avgAge: parseFloat(row.avg_age),
      };
    }

    const timeRangeResult = await this.pool.query(
      `SELECT MIN(captured_at) as earliest, MAX(captured_at) as latest FROM client_snapshots ${whereClause}`,
      params,
    );

    const timeRange =
      timeRangeResult.rows[0].earliest !== null && timeRangeResult.rows[0].latest !== null
        ? {
            earliest: parseInt(timeRangeResult.rows[0].earliest),
            latest: parseInt(timeRangeResult.rows[0].latest),
          }
        : null;

    return {
      currentConnections: parseInt(currentConnectionsResult.rows[0].count),
      peakConnections: parseInt(peakResult.rows[0]?.count || '0'),
      peakTimestamp: parseInt(peakResult.rows[0]?.captured_at || '0'),
      uniqueClientNames: parseInt(uniqueStatsResult.rows[0].unique_names),
      uniqueUsers: parseInt(uniqueStatsResult.rows[0].unique_users),
      uniqueIps: parseInt(uniqueStatsResult.rows[0].unique_ips),
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
    connectionId?: string,
  ): Promise<StoredClientSnapshot[]> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIndex = 1;

    if (connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(connectionId);
    }

    if (identifier.name) {
      conditions.push(`name = $${paramIndex++}`);
      params.push(identifier.name);
    }

    if (identifier.user) {
      conditions.push(`user_name = $${paramIndex++}`);
      params.push(identifier.user);
    }

    if (identifier.addr) {
      conditions.push(`addr = $${paramIndex++}`);
      params.push(identifier.addr);
    }

    if (startTime) {
      conditions.push(`captured_at >= $${paramIndex++}`);
      params.push(startTime);
    }

    if (endTime) {
      conditions.push(`captured_at <= $${paramIndex++}`);
      params.push(endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
      SELECT * FROM client_snapshots
      ${whereClause}
      ORDER BY captured_at ASC
    `;

    const result = await this.pool.query(query, params);
    return result.rows.map((row) => this.mappers.mapClientRow(row));
  }

  async pruneOldClientSnapshots(
    olderThanTimestamp: number,
    connectionId?: string,
  ): Promise<number> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM client_snapshots WHERE captured_at < $1 AND connection_id = $2',
        [olderThanTimestamp, connectionId],
      );
      return result.rowCount || 0;
    }

    const result = await this.pool.query('DELETE FROM client_snapshots WHERE captured_at < $1', [
      olderThanTimestamp,
    ]);

    return result.rowCount || 0;
  }

  private async createSchema(): Promise<void> {
    if (!this.pool) {
      return;
    }

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS acl_audit (
        id SERIAL PRIMARY KEY,
        count INTEGER NOT NULL,
        reason TEXT NOT NULL,
        context TEXT NOT NULL,
        object TEXT NOT NULL,
        username TEXT NOT NULL,
        age_seconds DOUBLE PRECISION NOT NULL,
        client_info TEXT NOT NULL,
        timestamp_created BIGINT NOT NULL,
        timestamp_last_updated BIGINT NOT NULL,
        captured_at BIGINT NOT NULL,
        source_host TEXT NOT NULL,
        source_port INTEGER NOT NULL,
        connection_id TEXT NOT NULL DEFAULT 'env-default',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(timestamp_created, username, object, reason, source_host, source_port, connection_id)
      );

      CREATE INDEX IF NOT EXISTS idx_acl_username ON acl_audit(username);
      CREATE INDEX IF NOT EXISTS idx_acl_reason ON acl_audit(reason);
      CREATE INDEX IF NOT EXISTS idx_acl_captured_at ON acl_audit(captured_at);
      CREATE INDEX IF NOT EXISTS idx_acl_timestamp_created ON acl_audit(timestamp_created);
      CREATE INDEX IF NOT EXISTS idx_acl_connection_id ON acl_audit(connection_id);

      -- Add unique constraint if missing (for tables created before this constraint was added)
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'acl_audit_timestamp_created_username_object_reason_source__key'
        ) THEN
          -- Remove duplicates first (keep the one with highest id)
          DELETE FROM acl_audit a USING acl_audit b
          WHERE a.id < b.id
            AND a.timestamp_created = b.timestamp_created
            AND a.username = b.username
            AND a.object = b.object
            AND a.reason = b.reason
            AND a.source_host = b.source_host
            AND a.source_port = b.source_port
            AND a.connection_id = b.connection_id;

          ALTER TABLE acl_audit
          ADD CONSTRAINT acl_audit_timestamp_created_username_object_reason_source__key
          UNIQUE (timestamp_created, username, object, reason, source_host, source_port, connection_id);
        END IF;
      EXCEPTION WHEN duplicate_object THEN
        -- Constraint already exists, ignore
      END $$;

      CREATE TABLE IF NOT EXISTS client_snapshots (
        id SERIAL PRIMARY KEY,
        client_id TEXT NOT NULL,
        addr TEXT NOT NULL,
        name TEXT,
        user_name TEXT,
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
        captured_at BIGINT NOT NULL,
        source_host TEXT NOT NULL,
        source_port INTEGER NOT NULL,
        connection_id TEXT NOT NULL DEFAULT 'env-default'
      );

      CREATE INDEX IF NOT EXISTS idx_client_captured_at ON client_snapshots(captured_at);
      CREATE INDEX IF NOT EXISTS idx_client_name ON client_snapshots(name);
      CREATE INDEX IF NOT EXISTS idx_client_user ON client_snapshots(user_name);
      CREATE INDEX IF NOT EXISTS idx_client_addr ON client_snapshots(addr);
      CREATE INDEX IF NOT EXISTS idx_client_idle ON client_snapshots(idle) WHERE idle > 300;
      CREATE INDEX IF NOT EXISTS idx_client_qbuf ON client_snapshots(qbuf) WHERE qbuf > 1000000;
      CREATE INDEX IF NOT EXISTS idx_client_omem ON client_snapshots(omem) WHERE omem > 10000000;
      CREATE INDEX IF NOT EXISTS idx_client_cmd ON client_snapshots(cmd);
      CREATE INDEX IF NOT EXISTS idx_client_captured_at_cmd ON client_snapshots(captured_at, cmd);
      CREATE INDEX IF NOT EXISTS idx_client_connection_id ON client_snapshots(connection_id);

      -- Anomaly Events Table
      CREATE TABLE IF NOT EXISTS anomaly_events (
        id UUID PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        metric_type VARCHAR(50) NOT NULL,
        anomaly_type VARCHAR(20) NOT NULL,
        severity VARCHAR(20) NOT NULL,
        value DOUBLE PRECISION NOT NULL,
        baseline DOUBLE PRECISION NOT NULL,
        std_dev DOUBLE PRECISION NOT NULL,
        z_score DOUBLE PRECISION NOT NULL,
        threshold DOUBLE PRECISION NOT NULL,
        message TEXT NOT NULL,
        correlation_id UUID,
        related_metrics TEXT[],
        resolved BOOLEAN DEFAULT FALSE,
        resolved_at BIGINT,
        duration_ms BIGINT,
        source_host VARCHAR(255),
        source_port INTEGER,
        connection_id TEXT NOT NULL DEFAULT 'env-default',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_anomaly_events_timestamp ON anomaly_events(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_anomaly_events_severity ON anomaly_events(severity, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_anomaly_events_metric ON anomaly_events(metric_type, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_anomaly_events_correlation ON anomaly_events(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_anomaly_events_unresolved ON anomaly_events(resolved, timestamp DESC) WHERE NOT resolved;
      CREATE INDEX IF NOT EXISTS idx_anomaly_events_connection_id ON anomaly_events(connection_id);

      -- Bulk-Delete Audit Table (one row per execute run of the SCANDEL-style tool)
      CREATE TABLE IF NOT EXISTS bulk_delete_audits (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        completed_at BIGINT,
        status VARCHAR(20) NOT NULL,
        match_pattern TEXT NOT NULL,
        type_filter VARCHAR(50),
        scope VARCHAR(20) NOT NULL,
        matched BIGINT NOT NULL DEFAULT 0,
        deleted BIGINT NOT NULL DEFAULT 0,
        batches INTEGER NOT NULL DEFAULT 0,
        nodes INTEGER NOT NULL DEFAULT 0,
        truncated BOOLEAN NOT NULL DEFAULT FALSE,
        skipped_nodes TEXT[],
        error TEXT,
        source_host VARCHAR(255),
        source_port INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_bulk_delete_audits_connection ON bulk_delete_audits(connection_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_bulk_delete_audits_timestamp ON bulk_delete_audits(timestamp DESC);

      -- Correlated Anomaly Groups Table
      CREATE TABLE IF NOT EXISTS correlated_anomaly_groups (
        correlation_id UUID PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        pattern VARCHAR(50) NOT NULL,
        severity VARCHAR(20) NOT NULL,
        diagnosis TEXT NOT NULL,
        recommendations TEXT[],
        anomaly_count INTEGER NOT NULL,
        metric_types TEXT[],
        source_host VARCHAR(255),
        source_port INTEGER,
        connection_id TEXT NOT NULL DEFAULT 'env-default',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_correlated_groups_timestamp ON correlated_anomaly_groups(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_correlated_groups_pattern ON correlated_anomaly_groups(pattern, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_correlated_groups_severity ON correlated_anomaly_groups(severity, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_correlated_groups_connection_id ON correlated_anomaly_groups(connection_id);

      CREATE TABLE IF NOT EXISTS key_pattern_snapshots (
        id UUID PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        pattern TEXT NOT NULL,
        key_count INTEGER NOT NULL,
        sampled_key_count INTEGER NOT NULL,
        keys_with_ttl INTEGER NOT NULL,
        keys_expiring_soon INTEGER NOT NULL,
        total_memory_bytes BIGINT NOT NULL,
        avg_memory_bytes INTEGER NOT NULL,
        max_memory_bytes INTEGER NOT NULL,
        avg_access_frequency DOUBLE PRECISION,
        hot_key_count INTEGER,
        cold_key_count INTEGER,
        avg_idle_time_seconds DOUBLE PRECISION,
        stale_key_count INTEGER,
        avg_ttl_seconds INTEGER,
        min_ttl_seconds INTEGER,
        max_ttl_seconds INTEGER,
        connection_id TEXT NOT NULL DEFAULT 'env-default',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_kps_timestamp ON key_pattern_snapshots(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_kps_pattern ON key_pattern_snapshots(pattern, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_kps_pattern_timestamp ON key_pattern_snapshots(pattern, timestamp);
      CREATE INDEX IF NOT EXISTS idx_kps_connection_id ON key_pattern_snapshots(connection_id);

      CREATE TABLE IF NOT EXISTS hot_key_stats (
        id UUID PRIMARY KEY,
        key_name TEXT NOT NULL,
        connection_id TEXT NOT NULL DEFAULT 'env-default',
        captured_at BIGINT NOT NULL,
        signal_type TEXT NOT NULL,
        freq_score INTEGER,
        idle_seconds INTEGER,
        memory_bytes BIGINT,
        cardinality BIGINT,
        key_type TEXT,
        ttl INTEGER,
        rank INTEGER NOT NULL
      );
      ALTER TABLE hot_key_stats ADD COLUMN IF NOT EXISTS cardinality BIGINT;
      ALTER TABLE hot_key_stats ADD COLUMN IF NOT EXISTS key_type TEXT;

      CREATE INDEX IF NOT EXISTS idx_hks_connection_captured
        ON hot_key_stats(connection_id, captured_at DESC);

      CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        audit_poll_interval_ms INTEGER NOT NULL DEFAULT 60000,
        client_analytics_poll_interval_ms INTEGER NOT NULL DEFAULT 60000,
        anomaly_poll_interval_ms INTEGER NOT NULL DEFAULT 1000,
        anomaly_cache_ttl_ms INTEGER NOT NULL DEFAULT 3600000,
        anomaly_prometheus_interval_ms INTEGER NOT NULL DEFAULT 30000,
        throughput_forecasting_enabled BOOLEAN NOT NULL DEFAULT true,
        throughput_forecasting_default_rolling_window_ms INTEGER NOT NULL DEFAULT 21600000,
        throughput_forecasting_default_alert_threshold_ms INTEGER NOT NULL DEFAULT 7200000,
        inference_sla_config JSONB NOT NULL DEFAULT '{}'::JSONB,
        updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
        created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
      );

      -- Migration: add throughput-forecasting columns if they don't exist
      ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS throughput_forecasting_enabled BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS throughput_forecasting_default_rolling_window_ms INTEGER NOT NULL DEFAULT 21600000;
      ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS throughput_forecasting_default_alert_threshold_ms INTEGER NOT NULL DEFAULT 7200000;
      ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS inference_sla_config JSONB NOT NULL DEFAULT '{}'::JSONB;

      CREATE TABLE IF NOT EXISTS metric_forecast_settings (
        connection_id TEXT NOT NULL,
        metric_kind TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        ceiling DOUBLE PRECISION,
        rolling_window_ms INTEGER NOT NULL DEFAULT 21600000,
        alert_threshold_ms INTEGER NOT NULL DEFAULT 7200000,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (connection_id, metric_kind)
      );

      CREATE TABLE IF NOT EXISTS webhooks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        url TEXT NOT NULL,
        secret TEXT,
        enabled BOOLEAN DEFAULT true,
        events TEXT[] NOT NULL,
        headers JSONB DEFAULT '{}',
        retry_policy JSONB NOT NULL,
        delivery_config JSONB,
        alert_config JSONB,
        thresholds JSONB,
        connection_id TEXT NOT NULL DEFAULT 'env-default',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Add columns if they don't exist (for existing databases)
      ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS delivery_config JSONB;
      ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS alert_config JSONB;
      ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS thresholds JSONB;

      CREATE INDEX IF NOT EXISTS idx_webhooks_connection_id ON webhooks(connection_id);

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
        event_type VARCHAR(50) NOT NULL,
        payload JSONB NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        status_code INT,
        response_body TEXT,
        attempts INT DEFAULT 0,
        next_retry_at TIMESTAMPTZ,
        connection_id TEXT NOT NULL DEFAULT 'env-default',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        duration_ms INT
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id);
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry ON webhook_deliveries(status, next_retry_at) WHERE status = 'retrying';
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_connection_id ON webhook_deliveries(connection_id);

      -- Slow Log Entries Table
      CREATE TABLE IF NOT EXISTS slow_log_entries (
        pk SERIAL PRIMARY KEY,
        slowlog_id BIGINT NOT NULL,
        timestamp BIGINT NOT NULL,
        duration BIGINT NOT NULL,
        command TEXT[] NOT NULL DEFAULT '{}',
        client_address TEXT,
        client_name TEXT,
        captured_at BIGINT NOT NULL,
        source_host TEXT NOT NULL,
        source_port INTEGER NOT NULL,
        connection_id TEXT NOT NULL DEFAULT 'env-default',
        UNIQUE(slowlog_id, source_host, source_port, connection_id)
      );

      CREATE INDEX IF NOT EXISTS idx_slowlog_timestamp ON slow_log_entries(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_slowlog_command ON slow_log_entries(command);
      CREATE INDEX IF NOT EXISTS idx_slowlog_duration ON slow_log_entries(duration DESC);
      CREATE INDEX IF NOT EXISTS idx_slowlog_client_name ON slow_log_entries(client_name);
      CREATE INDEX IF NOT EXISTS idx_slowlog_captured_at ON slow_log_entries(captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_slowlog_connection_id ON slow_log_entries(connection_id);

      -- Drop old unique constraint without connection_id if it exists
      DO $$
      BEGIN
        ALTER TABLE slow_log_entries
        DROP CONSTRAINT IF EXISTS slow_log_entries_slowlog_id_source_host_source_port_key;
      EXCEPTION WHEN undefined_object THEN
        -- Constraint doesn't exist, ignore
      END $$;

      -- Add unique constraint if missing (for tables created before this constraint was added)
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint c
          JOIN pg_class t ON c.conrelid = t.oid
          WHERE t.relname = 'slow_log_entries'
            AND c.contype = 'u'
            AND c.conkey @> ARRAY(
              SELECT attnum FROM pg_attribute
              WHERE attrelid = t.oid AND attname IN ('slowlog_id', 'source_host', 'source_port', 'connection_id')
            )
        ) THEN
          -- Remove duplicates first (keep the one with highest pk)
          DELETE FROM slow_log_entries a USING slow_log_entries b
          WHERE a.pk < b.pk
            AND a.slowlog_id = b.slowlog_id
            AND a.source_host = b.source_host
            AND a.source_port = b.source_port
            AND a.connection_id = b.connection_id;

          ALTER TABLE slow_log_entries
          ADD CONSTRAINT slow_log_entries_slowlog_id_source_host_source_port_conn_key
          UNIQUE (slowlog_id, source_host, source_port, connection_id);
        END IF;
      EXCEPTION WHEN duplicate_object THEN
        -- Constraint already exists, ignore
      END $$;

      -- Command Log Entries Table (Valkey-specific)
      CREATE TABLE IF NOT EXISTS command_log_entries (
        pk SERIAL PRIMARY KEY,
        commandlog_id BIGINT NOT NULL,
        timestamp BIGINT NOT NULL,
        duration BIGINT NOT NULL,
        command TEXT[] NOT NULL DEFAULT '{}',
        client_address TEXT,
        client_name TEXT,
        log_type TEXT NOT NULL,
        captured_at BIGINT NOT NULL,
        source_host TEXT NOT NULL,
        source_port INTEGER NOT NULL,
        connection_id TEXT NOT NULL DEFAULT 'env-default',
        UNIQUE(commandlog_id, log_type, source_host, source_port, connection_id)
      );

      CREATE INDEX IF NOT EXISTS idx_commandlog_timestamp ON command_log_entries(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_commandlog_type ON command_log_entries(log_type);
      CREATE INDEX IF NOT EXISTS idx_commandlog_duration ON command_log_entries(duration DESC);
      CREATE INDEX IF NOT EXISTS idx_commandlog_client_name ON command_log_entries(client_name);
      CREATE INDEX IF NOT EXISTS idx_commandlog_captured_at ON command_log_entries(captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_commandlog_connection_id ON command_log_entries(connection_id);

      -- Drop old unique constraint without connection_id if it exists
      DO $$
      BEGIN
        ALTER TABLE command_log_entries
        DROP CONSTRAINT IF EXISTS command_log_entries_commandlog_id_log_type_source_host_sour_key;
      EXCEPTION WHEN undefined_object THEN
        -- Constraint doesn't exist, ignore
      END $$;

      -- Add unique constraint if missing (for tables created before this constraint was added)
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint c
          JOIN pg_class t ON c.conrelid = t.oid
          WHERE t.relname = 'command_log_entries'
            AND c.contype = 'u'
            AND c.conkey @> ARRAY(
              SELECT attnum FROM pg_attribute
              WHERE attrelid = t.oid AND attname IN ('commandlog_id', 'log_type', 'source_host', 'source_port', 'connection_id')
            )
        ) THEN
          -- Remove duplicates first (keep the one with highest pk)
          DELETE FROM command_log_entries a USING command_log_entries b
          WHERE a.pk < b.pk
            AND a.commandlog_id = b.commandlog_id
            AND a.log_type = b.log_type
            AND a.source_host = b.source_host
            AND a.source_port = b.source_port
            AND a.connection_id = b.connection_id;

          ALTER TABLE command_log_entries
          ADD CONSTRAINT command_log_entries_cmdlog_id_type_host_port_conn_key
          UNIQUE (commandlog_id, log_type, source_host, source_port, connection_id);
        END IF;
      EXCEPTION WHEN duplicate_object THEN
        -- Constraint already exists, ignore
      END $$;

      -- Latency Snapshots Table
      CREATE TABLE IF NOT EXISTS latency_snapshots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        timestamp BIGINT NOT NULL,
        event_name VARCHAR NOT NULL,
        latest_event_timestamp BIGINT NOT NULL,
        max_latency INTEGER NOT NULL,
        connection_id TEXT NOT NULL DEFAULT 'env-default'
      );

      CREATE INDEX IF NOT EXISTS idx_latency_snap_timestamp ON latency_snapshots(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_latency_snap_event_name ON latency_snapshots(event_name);
      CREATE INDEX IF NOT EXISTS idx_latency_snap_connection_id ON latency_snapshots(connection_id);

      -- Latency Histograms Table
      CREATE TABLE IF NOT EXISTS latency_histograms (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        timestamp BIGINT NOT NULL,
        histogram_data JSONB NOT NULL,
        connection_id TEXT NOT NULL DEFAULT 'env-default'
      );

      CREATE INDEX IF NOT EXISTS idx_latency_hist_timestamp ON latency_histograms(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_latency_hist_connection_id ON latency_histograms(connection_id);

      -- Memory Snapshots Table
      CREATE TABLE IF NOT EXISTS memory_snapshots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        timestamp BIGINT NOT NULL,
        used_memory BIGINT NOT NULL,
        used_memory_rss BIGINT NOT NULL,
        used_memory_peak BIGINT NOT NULL,
        mem_fragmentation_ratio DOUBLE PRECISION NOT NULL,
        maxmemory BIGINT NOT NULL DEFAULT 0,
        allocator_frag_ratio DOUBLE PRECISION NOT NULL DEFAULT 0,
        ops_per_sec BIGINT NOT NULL DEFAULT 0,
        cpu_sys DOUBLE PRECISION NOT NULL DEFAULT 0,
        cpu_user DOUBLE PRECISION NOT NULL DEFAULT 0,
        io_threaded_reads BIGINT NOT NULL DEFAULT 0,
        io_threaded_writes BIGINT NOT NULL DEFAULT 0,
        connection_id TEXT NOT NULL DEFAULT 'env-default'
      );

      CREATE INDEX IF NOT EXISTS idx_memory_snap_timestamp ON memory_snapshots(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_snap_connection_id ON memory_snapshots(connection_id);

      CREATE TABLE IF NOT EXISTS command_stats_samples (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        command TEXT NOT NULL,
        calls_total BIGINT NOT NULL DEFAULT 0,
        usec_total BIGINT NOT NULL DEFAULT 0,
        usec_per_call DOUBLE PRECISION NOT NULL DEFAULT 0,
        rejected_calls BIGINT NOT NULL DEFAULT 0,
        failed_calls BIGINT NOT NULL DEFAULT 0,
        calls_delta BIGINT NOT NULL,
        usec_delta BIGINT NOT NULL,
        interval_ms INTEGER NOT NULL,
        captured_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cmdstat_captured_at
        ON command_stats_samples(connection_id, command, captured_at);

      CREATE TABLE IF NOT EXISTS latency_stats_samples (
        id UUID PRIMARY KEY,
        connection_id TEXT NOT NULL,
        command TEXT NOT NULL,
        p50_us DOUBLE PRECISION NOT NULL DEFAULT 0,
        p99_us DOUBLE PRECISION NOT NULL DEFAULT 0,
        p999_us DOUBLE PRECISION NOT NULL DEFAULT 0,
        server_version TEXT NOT NULL DEFAULT '',
        captured_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_latstat_cmd_captured_at
        ON latency_stats_samples(connection_id, command, captured_at);
      CREATE INDEX IF NOT EXISTS idx_latstat_captured_at
        ON latency_stats_samples(connection_id, captured_at);

      CREATE TABLE IF NOT EXISTS ai_cache_samples (
        id UUID PRIMARY KEY,
        connection_id TEXT NOT NULL,
        instance_field TEXT NOT NULL,
        instance_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        hits BIGINT NOT NULL DEFAULT 0,
        misses BIGINT NOT NULL DEFAULT 0,
        hit_rate DOUBLE PRECISION,
        cost_saved_micros BIGINT NOT NULL DEFAULT 0,
        evictions BIGINT NOT NULL DEFAULT 0,
        items BIGINT,
        index_bytes BIGINT,
        threshold DOUBLE PRECISION,
        extra TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_aicache_field_ts
        ON ai_cache_samples(connection_id, instance_field, timestamp);
      CREATE INDEX IF NOT EXISTS idx_aicache_ts
        ON ai_cache_samples(connection_id, timestamp);

      CREATE TABLE IF NOT EXISTS otel_spans (
        trace_id TEXT NOT NULL,
        span_id TEXT NOT NULL,
        parent_span_id TEXT,
        name TEXT NOT NULL,
        scope_name TEXT NOT NULL DEFAULT '',
        service_name TEXT,
        kind INTEGER NOT NULL DEFAULT 0,
        start_time_unix_nano TEXT NOT NULL DEFAULT '0',
        end_time_unix_nano TEXT NOT NULL DEFAULT '0',
        start_time_ms BIGINT NOT NULL,
        duration_ns BIGINT NOT NULL DEFAULT 0,
        status_code INTEGER NOT NULL DEFAULT 0,
        status_message TEXT,
        attributes TEXT NOT NULL DEFAULT '{}',
        ingested_at BIGINT NOT NULL,
        PRIMARY KEY (trace_id, span_id)
      );

      CREATE INDEX IF NOT EXISTS idx_otel_trace ON otel_spans(trace_id);
      CREATE INDEX IF NOT EXISTS idx_otel_start ON otel_spans(start_time_ms);

      CREATE TABLE IF NOT EXISTS vector_index_snapshots (
        id TEXT PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        connection_id TEXT NOT NULL,
        index_name TEXT NOT NULL,
        num_docs INTEGER NOT NULL,
        num_records INTEGER NOT NULL DEFAULT 0,
        num_deleted_docs INTEGER NOT NULL DEFAULT 0,
        indexing_failures INTEGER NOT NULL DEFAULT 0,
        indexing_failures_delta INTEGER NOT NULL DEFAULT 0,
        percent_indexed DOUBLE PRECISION NOT NULL DEFAULT 0,
        indexing_state TEXT NOT NULL DEFAULT 'indexed',
        total_indexing_time BIGINT NOT NULL DEFAULT 0,
        memory_size_mb DOUBLE PRECISION NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_vis_timestamp ON vector_index_snapshots(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_vis_connection_index ON vector_index_snapshots(connection_id, index_name);

      ALTER TABLE vector_index_snapshots ADD COLUMN IF NOT EXISTS num_records INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE vector_index_snapshots ADD COLUMN IF NOT EXISTS num_deleted_docs INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE vector_index_snapshots ADD COLUMN IF NOT EXISTS indexing_failures INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE vector_index_snapshots ADD COLUMN IF NOT EXISTS indexing_failures_delta INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE vector_index_snapshots ADD COLUMN IF NOT EXISTS percent_indexed DOUBLE PRECISION NOT NULL DEFAULT 0;
      ALTER TABLE vector_index_snapshots ADD COLUMN IF NOT EXISTS indexing_state TEXT NOT NULL DEFAULT 'indexed';
      ALTER TABLE vector_index_snapshots ADD COLUMN IF NOT EXISTS total_indexing_time BIGINT NOT NULL DEFAULT 0;

      ALTER TABLE command_stats_samples ADD COLUMN IF NOT EXISTS calls_total BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE command_stats_samples ADD COLUMN IF NOT EXISTS usec_total BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE command_stats_samples ADD COLUMN IF NOT EXISTS usec_per_call DOUBLE PRECISION NOT NULL DEFAULT 0;
      ALTER TABLE command_stats_samples ADD COLUMN IF NOT EXISTS rejected_calls BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE command_stats_samples ADD COLUMN IF NOT EXISTS failed_calls BIGINT NOT NULL DEFAULT 0;

      -- Idempotent migration for existing deployments without ops/CPU/IO columns
      ALTER TABLE memory_snapshots ADD COLUMN IF NOT EXISTS ops_per_sec BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE memory_snapshots ADD COLUMN IF NOT EXISTS cpu_sys DOUBLE PRECISION NOT NULL DEFAULT 0;
      ALTER TABLE memory_snapshots ADD COLUMN IF NOT EXISTS cpu_user DOUBLE PRECISION NOT NULL DEFAULT 0;
      ALTER TABLE memory_snapshots ADD COLUMN IF NOT EXISTS io_threaded_reads BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE memory_snapshots ADD COLUMN IF NOT EXISTS io_threaded_writes BIGINT NOT NULL DEFAULT 0;

      -- Database Connections Table (stores multi-database connection configs)
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT,
        password TEXT,
        password_encrypted BOOLEAN NOT NULL DEFAULT false,
        db_index INTEGER NOT NULL DEFAULT 0,
        tls BOOLEAN NOT NULL DEFAULT false,
        is_default BOOLEAN NOT NULL DEFAULT false,
        created_at BIGINT NOT NULL,
        updated_at BIGINT
      );

      -- Migration: add password_encrypted column if it doesn't exist
      ALTER TABLE connections ADD COLUMN IF NOT EXISTS password_encrypted BOOLEAN NOT NULL DEFAULT false;

      CREATE INDEX IF NOT EXISTS idx_connections_is_default ON connections(is_default);

      -- Agent Tokens Table (cloud-only)
      CREATE TABLE IF NOT EXISTS agent_tokens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'agent',
        token_hash TEXT NOT NULL UNIQUE,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        revoked_at BIGINT,
        last_used_at BIGINT
      );

      CREATE INDEX IF NOT EXISTS idx_agent_tokens_hash ON agent_tokens(token_hash);

      ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'agent';

      CREATE TABLE IF NOT EXISTS cache_proposals (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        cache_name TEXT NOT NULL,
        cache_type TEXT NOT NULL,
        proposal_type TEXT NOT NULL,
        proposal_payload JSONB NOT NULL,
        reasoning TEXT,
        status TEXT NOT NULL,
        proposed_by TEXT,
        proposed_at BIGINT NOT NULL,
        reviewed_by TEXT,
        reviewed_at BIGINT,
        applied_at BIGINT,
        applied_result JSONB,
        expires_at BIGINT NOT NULL,
        CHECK (cache_type IN ('agent_cache', 'semantic_cache')),
        CHECK (status IN ('pending','approved','rejected','applied','failed','expired')),
        CHECK (
          (cache_type = 'semantic_cache' AND proposal_type IN ('threshold_adjust','invalidate'))
          OR (cache_type = 'agent_cache' AND proposal_type IN ('tool_ttl_adjust','invalidate'))
        )
      );

      CREATE INDEX IF NOT EXISTS idx_cache_proposals_conn_status_proposed
        ON cache_proposals(connection_id, status, proposed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cache_proposals_pending_lookup
        ON cache_proposals(connection_id, cache_name, proposal_type)
        WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_cache_proposals_expires_at
        ON cache_proposals(expires_at)
        WHERE status = 'pending';
      -- Drop legacy indexes that did NOT COALESCE NULL category/tool_name.
      -- These were never released; the DROP fires once on dev DBs created
      -- before the rename and is a no-op afterwards.
      DROP INDEX IF EXISTS uniq_cache_proposals_pending_threshold;
      DROP INDEX IF EXISTS uniq_cache_proposals_pending_tool_ttl;
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_cache_proposals_pending_threshold_v2
        ON cache_proposals(
          connection_id,
          cache_name,
          COALESCE(proposal_payload->>'category', '__betterdb_null__')
        )
        WHERE status = 'pending' AND proposal_type = 'threshold_adjust';
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_cache_proposals_pending_tool_ttl_v2
        ON cache_proposals(
          connection_id,
          cache_name,
          COALESCE(proposal_payload->>'tool_name', '__betterdb_null__')
        )
        WHERE status = 'pending' AND proposal_type = 'tool_ttl_adjust';

      CREATE TABLE IF NOT EXISTS cache_proposal_audit (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL REFERENCES cache_proposals(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        event_payload JSONB,
        event_at BIGINT NOT NULL,
        actor TEXT,
        actor_source TEXT NOT NULL,
        CHECK (event_type IN ('proposed','approved','rejected','edited_and_approved','applied','failed','expired','outcome_evaluated')),
        CHECK (actor_source IN ('ui','mcp','system'))
      );

      CREATE INDEX IF NOT EXISTS idx_cache_proposal_audit_proposal
        ON cache_proposal_audit(proposal_id, event_at DESC);

      CREATE TABLE IF NOT EXISTS memory_proposals (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        store_name TEXT NOT NULL,
        proposal_type TEXT NOT NULL,
        proposal_payload JSONB NOT NULL,
        reasoning TEXT,
        status TEXT NOT NULL,
        proposed_by TEXT,
        proposed_at BIGINT NOT NULL,
        reviewed_by TEXT,
        reviewed_at BIGINT,
        applied_at BIGINT,
        applied_result JSONB,
        expires_at BIGINT NOT NULL,
        CHECK (proposal_type = 'forget'),
        CHECK (status IN ('pending','approved','applying','applied','failed','rejected','expired'))
      );

      CREATE INDEX IF NOT EXISTS idx_memory_proposals_conn_status_proposed
        ON memory_proposals(connection_id, status, proposed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_proposals_pending_lookup
        ON memory_proposals(connection_id, store_name)
        WHERE status = 'pending';

      CREATE TABLE IF NOT EXISTS memory_proposal_audit (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL REFERENCES memory_proposals(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        event_payload JSONB,
        event_at BIGINT NOT NULL,
        actor TEXT,
        actor_source TEXT NOT NULL,
        CHECK (event_type IN ('proposed','approved','rejected','edited_and_approved','applied','failed','expired','outcome_evaluated')),
        CHECK (actor_source IN ('ui','mcp','system'))
      );

      CREATE INDEX IF NOT EXISTS idx_memory_proposal_audit_proposal
        ON memory_proposal_audit(proposal_id, event_at DESC);

      -- Monitor Capture Sessions Table
      CREATE TABLE IF NOT EXISTS capture_sessions (
        id UUID PRIMARY KEY,
        connection_id TEXT NOT NULL,
        status VARCHAR(20) NOT NULL,
        source VARCHAR(20) NOT NULL,
        trigger_id UUID,
        schedule_id UUID,
        requested_by TEXT,
        started_at BIGINT NOT NULL,
        ended_at BIGINT,
        duration_ms BIGINT,
        byte_count BIGINT NOT NULL DEFAULT 0,
        line_count BIGINT NOT NULL DEFAULT 0,
        byte_cap BIGINT NOT NULL,
        line_cap BIGINT NOT NULL,
        termination_reason TEXT,
        target_node TEXT,
        node_segments JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CHECK (status IN ('running','completed','truncated','failed','skipped')),
        CHECK (source IN ('manual','trigger','schedule'))
      );

      ALTER TABLE capture_sessions ADD COLUMN IF NOT EXISTS target_node TEXT;
      ALTER TABLE capture_sessions ADD COLUMN IF NOT EXISTS node_segments JSONB;

      CREATE INDEX IF NOT EXISTS idx_capture_sessions_connection_id ON capture_sessions(connection_id);
      CREATE INDEX IF NOT EXISTS idx_capture_sessions_started_at ON capture_sessions(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_capture_sessions_status ON capture_sessions(status, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_capture_sessions_source ON capture_sessions(source, started_at DESC);

      -- Monitor Capture Chunks Table (one row per batched MONITOR-line chunk; populated by CaptureWriter in a later PR)
      CREATE TABLE IF NOT EXISTS capture_chunks (
        session_id UUID NOT NULL REFERENCES capture_sessions(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        bytes BYTEA NOT NULL,
        line_count INTEGER NOT NULL,
        first_ts BIGINT NOT NULL,
        last_ts BIGINT NOT NULL,
        node_id TEXT,
        PRIMARY KEY(session_id, chunk_index)
      );

      ALTER TABLE capture_chunks ADD COLUMN IF NOT EXISTS node_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_capture_chunks_session ON capture_chunks(session_id, chunk_index);

      -- Pro+ Capture Triggers Table (PR 15)
      CREATE TABLE IF NOT EXISTS capture_triggers (
        id UUID PRIMARY KEY,
        connection_id TEXT NOT NULL,
        metric_type TEXT NOT NULL,
        anomaly_type TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        created_by TEXT,
        status VARCHAR(20) NOT NULL,
        fired_at BIGINT,
        fired_session_id UUID,
        skip_reason TEXT,
        CHECK (status IN ('configured','queued','fired','skipped','expired','cancelled'))
      );

      CREATE INDEX IF NOT EXISTS idx_capture_triggers_conn_status
        ON capture_triggers(connection_id, status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_capture_triggers_dedup
        ON capture_triggers(connection_id, metric_type, anomaly_type, status);

      -- Pro+ Scheduled Captures Table (PR 19, cron column added in PR 20)
      CREATE TABLE IF NOT EXISTS scheduled_captures (
        id UUID PRIMARY KEY,
        connection_id TEXT NOT NULL,
        interval_seconds INTEGER,
        cron_expression TEXT,
        duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
        status VARCHAR(20) NOT NULL,
        created_at BIGINT NOT NULL,
        created_by TEXT,
        last_fired_at BIGINT,
        last_fired_session_id UUID,
        last_skip_reason TEXT,
        CHECK (status IN ('enabled','disabled')),
        CHECK (
          (interval_seconds IS NOT NULL AND cron_expression IS NULL)
          OR (interval_seconds IS NULL AND cron_expression IS NOT NULL)
        ),
        CHECK (interval_seconds IS NULL OR interval_seconds >= 10)
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_captures_conn_status
        ON scheduled_captures(connection_id, status);

      -- Idempotent migration for deployments that ran the PR 19 schema
      ALTER TABLE scheduled_captures
        ADD COLUMN IF NOT EXISTS cron_expression TEXT;
    `);
  }

  async saveBulkDeleteAudit(record: StoredBulkDeleteAudit): Promise<string> {
    if (!this.pool) throw new Error('Database not initialized');

    await this.pool.query(
      `INSERT INTO bulk_delete_audits (
        id, connection_id, timestamp, completed_at, status,
        match_pattern, type_filter, scope,
        matched, deleted, batches, nodes, truncated, skipped_nodes,
        error, source_host, source_port
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT (id) DO UPDATE SET
        completed_at = EXCLUDED.completed_at,
        status = EXCLUDED.status,
        matched = EXCLUDED.matched,
        deleted = EXCLUDED.deleted,
        batches = EXCLUDED.batches,
        nodes = EXCLUDED.nodes,
        truncated = EXCLUDED.truncated,
        skipped_nodes = EXCLUDED.skipped_nodes,
        error = EXCLUDED.error`,
      [
        record.id,
        record.connectionId,
        record.timestamp,
        record.completedAt ?? null,
        record.status,
        record.match,
        record.type ?? null,
        record.scope,
        record.matched,
        record.deleted,
        record.batches,
        record.nodes,
        record.truncated,
        record.skippedNodes ?? [],
        record.error ?? null,
        record.sourceHost ?? null,
        record.sourcePort ?? null,
      ],
    );

    return record.id;
  }

  async markInterruptedBulkDeleteRuns(error: string, completedAt: number): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');
    const result = await this.pool.query(
      `UPDATE bulk_delete_audits
       SET status = 'failed', error = $1, completed_at = $2
       WHERE status = 'running'`,
      [error, completedAt],
    );
    return result.rowCount ?? 0;
  }

  async getBulkDeleteAudits(
    options: BulkDeleteAuditQueryOptions = {},
  ): Promise<StoredBulkDeleteAudit[]> {
    if (!this.pool) throw new Error('Database not initialized');

    const conditions: string[] = [];
    const params: Array<string | number> = [];
    let idx = 1;
    if (options.connectionId) {
      conditions.push(`connection_id = $${idx++}`);
      params.push(options.connectionId);
    }
    if (options.startTime) {
      conditions.push(`timestamp >= $${idx++}`);
      params.push(options.startTime);
    }
    if (options.endTime) {
      conditions.push(`timestamp <= $${idx++}`);
      params.push(options.endTime);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(options.limit ?? 100);

    const result = await this.pool.query(
      `SELECT * FROM bulk_delete_audits ${where} ORDER BY timestamp DESC LIMIT $${idx}`,
      params,
    );

    return result.rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      connectionId: row.connection_id as string,
      timestamp: Number(row.timestamp),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
      status: row.status as StoredBulkDeleteAudit['status'],
      match: row.match_pattern as string,
      type: (row.type_filter as string | null) ?? null,
      scope: row.scope as StoredBulkDeleteAudit['scope'],
      matched: Number(row.matched),
      deleted: Number(row.deleted),
      batches: Number(row.batches),
      nodes: Number(row.nodes),
      truncated: Boolean(row.truncated),
      skippedNodes: Array.isArray(row.skipped_nodes) ? (row.skipped_nodes as string[]) : [],
      error: (row.error as string | null) ?? null,
      sourceHost: (row.source_host as string | null) ?? null,
      sourcePort: row.source_port === null ? null : Number(row.source_port),
    }));
  }

  async saveAnomalyEvent(event: StoredAnomalyEvent, connectionId: string): Promise<string> {
    if (!this.pool) throw new Error('Database not initialized');

    await this.pool.query(
      `INSERT INTO anomaly_events (
        id, timestamp, metric_type, anomaly_type, severity,
        value, baseline, std_dev, z_score, threshold,
        message, correlation_id, related_metrics,
        resolved, resolved_at, duration_ms,
        source_host, source_port, connection_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      ON CONFLICT (id) DO UPDATE SET
        correlation_id = COALESCE(EXCLUDED.correlation_id, anomaly_events.correlation_id),
        related_metrics = COALESCE(EXCLUDED.related_metrics, anomaly_events.related_metrics),
        resolved = EXCLUDED.resolved,
        resolved_at = EXCLUDED.resolved_at,
        duration_ms = EXCLUDED.duration_ms`,
      [
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
        event.relatedMetrics || [],
        event.resolved,
        event.resolvedAt || null,
        event.durationMs || null,
        event.sourceHost || null,
        event.sourcePort || null,
        connectionId,
      ],
    );

    return event.id;
  }

  async saveAnomalyEvents(events: StoredAnomalyEvent[], connectionId: string): Promise<number> {
    if (!this.pool || events.length === 0) return 0;

    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const event of events) {
      placeholders.push(`(
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}
      )`);
      values.push(
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
        event.relatedMetrics || [],
        event.resolved,
        event.resolvedAt || null,
        event.durationMs || null,
        event.sourceHost || null,
        event.sourcePort || null,
        connectionId,
      );
    }

    const result = await this.pool.query(
      `INSERT INTO anomaly_events (
        id, timestamp, metric_type, anomaly_type, severity,
        value, baseline, std_dev, z_score, threshold,
        message, correlation_id, related_metrics,
        resolved, resolved_at, duration_ms,
        source_host, source_port, connection_id
      ) VALUES ${placeholders.join(', ')}
      ON CONFLICT (id) DO UPDATE SET
        correlation_id = COALESCE(EXCLUDED.correlation_id, anomaly_events.correlation_id),
        related_metrics = COALESCE(EXCLUDED.related_metrics, anomaly_events.related_metrics),
        resolved = EXCLUDED.resolved,
        resolved_at = EXCLUDED.resolved_at,
        duration_ms = EXCLUDED.duration_ms`,
      values,
    );

    return result.rowCount ?? 0;
  }

  async getAnomalyEvents(options: AnomalyQueryOptions = {}): Promise<StoredAnomalyEvent[]> {
    if (!this.pool) throw new Error('Database not initialized');

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (options.connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(options.connectionId);
    }
    if (options.startTime) {
      conditions.push(`timestamp >= $${paramIndex++}`);
      params.push(options.startTime);
    }
    if (options.endTime) {
      conditions.push(`timestamp <= $${paramIndex++}`);
      params.push(options.endTime);
    }
    if (options.severity) {
      conditions.push(`severity = $${paramIndex++}`);
      params.push(options.severity);
    }
    if (options.metricType) {
      conditions.push(`metric_type = $${paramIndex++}`);
      params.push(options.metricType);
    }
    if (options.resolved !== undefined) {
      conditions.push(`resolved = $${paramIndex++}`);
      params.push(options.resolved);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const result = await this.pool.query(
      `SELECT
        id, timestamp, metric_type, anomaly_type, severity,
        value, baseline, std_dev, z_score, threshold,
        message, correlation_id, related_metrics,
        resolved, resolved_at, duration_ms,
        source_host, source_port, connection_id
      FROM anomaly_events
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset],
    );

    return result.rows.map((row) => this.mappers.mapAnomalyEventRow(row));
  }

  async getAnomalyStats(
    startTime?: number,
    endTime?: number,
    connectionId?: string,
  ): Promise<AnomalyStats> {
    if (!this.pool) throw new Error('Database not initialized');

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(connectionId);
    }
    if (startTime) {
      conditions.push(`timestamp >= $${paramIndex++}`);
      params.push(startTime);
    }
    if (endTime) {
      conditions.push(`timestamp <= $${paramIndex++}`);
      params.push(endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const totalResult = await this.pool.query(
      `SELECT COUNT(*) as total FROM anomaly_events ${whereClause}`,
      params,
    );

    const severityResult = await this.pool.query(
      `SELECT severity, COUNT(*) as count FROM anomaly_events ${whereClause} GROUP BY severity`,
      params,
    );

    const metricResult = await this.pool.query(
      `SELECT metric_type, COUNT(*) as count FROM anomaly_events ${whereClause} GROUP BY metric_type`,
      params,
    );

    const unresolvedConditions = [...conditions];
    if (unresolvedConditions.length > 0) {
      unresolvedConditions.push(`resolved = false`);
    }
    const unresolvedWhereClause =
      unresolvedConditions.length > 0
        ? `WHERE ${unresolvedConditions.join(' AND ')}`
        : 'WHERE resolved = false';

    const unresolvedResult = await this.pool.query(
      `SELECT COUNT(*) as count FROM anomaly_events ${unresolvedWhereClause}`,
      params,
    );

    const bySeverity: Record<string, number> = {};
    for (const row of severityResult.rows) {
      bySeverity[row.severity] = parseInt(row.count);
    }

    const byMetric: Record<string, number> = {};
    for (const row of metricResult.rows) {
      byMetric[row.metric_type] = parseInt(row.count);
    }

    return {
      totalEvents: parseInt(totalResult.rows[0].total),
      bySeverity,
      byMetric,
      byPattern: {},
      unresolvedCount: parseInt(unresolvedResult.rows[0].count),
    };
  }

  async resolveAnomaly(id: string, resolvedAt: number): Promise<boolean> {
    if (!this.pool) throw new Error('Database not initialized');

    const result = await this.pool.query(
      `UPDATE anomaly_events
       SET resolved = true, resolved_at = $2, duration_ms = $2 - timestamp
       WHERE id = $1 AND resolved = false`,
      [id, resolvedAt],
    );

    if ((result.rowCount ?? 0) > 0) return true;
    // No row updated — distinguish an already-resolved anomaly (idempotent success)
    // from a non-existent one, so group resolution isn't failed by an already-closed member.
    const existing = await this.pool.query('SELECT 1 FROM anomaly_events WHERE id = $1', [id]);
    return (existing.rowCount ?? 0) > 0;
  }

  async pruneOldAnomalyEvents(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM anomaly_events WHERE timestamp < $1 AND connection_id = $2',
        [cutoffTimestamp, connectionId],
      );
      return result.rowCount ?? 0;
    }

    const result = await this.pool.query('DELETE FROM anomaly_events WHERE timestamp < $1', [
      cutoffTimestamp,
    ]);

    return result.rowCount ?? 0;
  }

  async saveCorrelatedGroup(group: StoredCorrelatedGroup, connectionId: string): Promise<string> {
    if (!this.pool) throw new Error('Database not initialized');

    await this.pool.query(
      `INSERT INTO correlated_anomaly_groups (
        correlation_id, timestamp, pattern, severity,
        diagnosis, recommendations, anomaly_count, metric_types,
        source_host, source_port, connection_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (correlation_id) DO UPDATE SET
        diagnosis = EXCLUDED.diagnosis,
        recommendations = EXCLUDED.recommendations,
        anomaly_count = EXCLUDED.anomaly_count`,
      [
        group.correlationId,
        group.timestamp,
        group.pattern,
        group.severity,
        group.diagnosis,
        group.recommendations,
        group.anomalyCount,
        group.metricTypes,
        group.sourceHost || null,
        group.sourcePort || null,
        connectionId,
      ],
    );

    return group.correlationId;
  }

  async getCorrelatedGroups(options: AnomalyQueryOptions = {}): Promise<StoredCorrelatedGroup[]> {
    if (!this.pool) throw new Error('Database not initialized');

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (options.connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(options.connectionId);
    }
    if (options.startTime) {
      conditions.push(`timestamp >= $${paramIndex++}`);
      params.push(options.startTime);
    }
    if (options.endTime) {
      conditions.push(`timestamp <= $${paramIndex++}`);
      params.push(options.endTime);
    }
    if (options.severity) {
      conditions.push(`severity = $${paramIndex++}`);
      params.push(options.severity);
    }
    if (options.pattern) {
      conditions.push(`pattern = $${paramIndex++}`);
      params.push(options.pattern);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    const result = await this.pool.query(
      `SELECT
        correlation_id, timestamp, pattern, severity,
        diagnosis, recommendations, anomaly_count, metric_types,
        source_host, source_port, connection_id
      FROM correlated_anomaly_groups
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset],
    );

    return result.rows.map((row) => this.mappers.mapCorrelatedGroupRow(row));
  }

  async pruneOldCorrelatedGroups(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM correlated_anomaly_groups WHERE timestamp < $1 AND connection_id = $2',
        [cutoffTimestamp, connectionId],
      );
      return result.rowCount ?? 0;
    }

    const result = await this.pool.query(
      'DELETE FROM correlated_anomaly_groups WHERE timestamp < $1',
      [cutoffTimestamp],
    );

    return result.rowCount ?? 0;
  }

  async saveKeyPatternSnapshots(
    snapshots: KeyPatternSnapshot[],
    connectionId: string,
  ): Promise<number> {
    if (!this.pool || snapshots.length === 0) return 0;

    const values: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    for (const snapshot of snapshots) {
      values.push(
        `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`,
      );
      params.push(
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
        connectionId,
      );
    }

    await this.pool.query(
      `
      INSERT INTO key_pattern_snapshots (
        id, timestamp, pattern, key_count, sampled_key_count,
        keys_with_ttl, keys_expiring_soon, total_memory_bytes,
        avg_memory_bytes, max_memory_bytes, avg_access_frequency,
        hot_key_count, cold_key_count, avg_idle_time_seconds,
        stale_key_count, avg_ttl_seconds, min_ttl_seconds, max_ttl_seconds, connection_id
      ) VALUES ${values.join(', ')}
    `,
      params,
    );

    return snapshots.length;
  }

  async getKeyPatternSnapshots(
    options: KeyPatternQueryOptions = {},
  ): Promise<KeyPatternSnapshot[]> {
    if (!this.pool) throw new Error('Database not initialized');

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (options.connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(options.connectionId);
    }
    if (options.startTime) {
      conditions.push(`timestamp >= $${paramIndex++}`);
      params.push(options.startTime);
    }
    if (options.endTime) {
      conditions.push(`timestamp <= $${paramIndex++}`);
      params.push(options.endTime);
    }
    if (options.pattern) {
      conditions.push(`pattern = $${paramIndex++}`);
      params.push(options.pattern);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const result = await this.pool.query(
      `
      SELECT * FROM key_pattern_snapshots
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `,
      [...params, limit, offset],
    );

    return result.rows.map((row) => this.mappers.mapKeyPatternSnapshotRow(row));
  }

  async getKeyAnalyticsSummary(
    startTime?: number,
    endTime?: number,
    connectionId?: string,
  ): Promise<KeyAnalyticsSummary | null> {
    if (!this.pool) throw new Error('Database not initialized');

    const conditions: string[] = [];
    const params: (number | string)[] = [];
    let paramIndex = 1;

    if (connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(connectionId);
    }
    if (startTime) {
      conditions.push(`timestamp >= $${paramIndex++}`);
      params.push(startTime);
    }
    if (endTime) {
      conditions.push(`timestamp <= $${paramIndex++}`);
      params.push(endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const latestSnapshotsResult = await this.pool.query(
      `
      SELECT pattern, MAX(timestamp) as latest_timestamp
      FROM key_pattern_snapshots
      ${whereClause}
      GROUP BY pattern
    `,
      params,
    );

    if (latestSnapshotsResult.rows.length === 0) return null;

    const patternConditions = latestSnapshotsResult.rows
      .map(() => '(pattern = ? AND timestamp = ?)')
      .join(' OR ');
    const patternParams: any[] = [];
    for (const row of latestSnapshotsResult.rows) {
      patternParams.push(row.pattern, row.latest_timestamp);
    }

    let pIdx = 1;
    const patternPlaceholders = latestSnapshotsResult.rows
      .map(() => `(pattern = $${pIdx++} AND timestamp = $${pIdx++})`)
      .join(' OR ');

    const summaryResult = await this.pool.query(
      `
      SELECT
        COUNT(DISTINCT pattern) as total_patterns,
        SUM(key_count) as total_keys,
        SUM(total_memory_bytes) as total_memory_bytes,
        SUM(stale_key_count) as stale_key_count,
        SUM(hot_key_count) as hot_key_count,
        SUM(cold_key_count) as cold_key_count,
        SUM(keys_expiring_soon) as keys_expiring_soon
      FROM key_pattern_snapshots
      WHERE ${patternPlaceholders}
    `,
      patternParams,
    );

    const summary = summaryResult.rows[0];

    const patternRowsResult = await this.pool.query(
      `
      SELECT pattern, key_count, total_memory_bytes, avg_memory_bytes, stale_key_count, hot_key_count, cold_key_count
      FROM key_pattern_snapshots
      WHERE ${patternPlaceholders}
    `,
      patternParams,
    );

    const byPattern: Record<string, any> = {};
    for (const row of patternRowsResult.rows) {
      byPattern[row.pattern] = {
        keyCount: row.key_count,
        memoryBytes: parseInt(row.total_memory_bytes),
        avgMemoryBytes: row.avg_memory_bytes,
        staleCount: row.stale_key_count ?? 0,
        hotCount: row.hot_key_count ?? 0,
        coldCount: row.cold_key_count ?? 0,
      };
    }

    const timeRangeResult = await this.pool.query(
      `
      SELECT MIN(timestamp) as earliest, MAX(timestamp) as latest
      FROM key_pattern_snapshots ${whereClause}
    `,
      params,
    );

    const timeRange =
      timeRangeResult.rows[0].earliest !== null && timeRangeResult.rows[0].latest !== null
        ? {
            earliest: parseInt(timeRangeResult.rows[0].earliest),
            latest: parseInt(timeRangeResult.rows[0].latest),
          }
        : null;

    return {
      totalPatterns: parseInt(summary.total_patterns) || 0,
      totalKeys: parseInt(summary.total_keys) || 0,
      totalMemoryBytes: parseInt(summary.total_memory_bytes) || 0,
      staleKeyCount: parseInt(summary.stale_key_count) || 0,
      hotKeyCount: parseInt(summary.hot_key_count) || 0,
      coldKeyCount: parseInt(summary.cold_key_count) || 0,
      keysExpiringSoon: parseInt(summary.keys_expiring_soon) || 0,
      byPattern,
      timeRange,
    };
  }

  async getKeyPatternTrends(
    pattern: string,
    startTime: number,
    endTime: number,
    connectionId?: string,
  ): Promise<
    Array<{
      timestamp: number;
      keyCount: number;
      memoryBytes: number;
      staleCount: number;
    }>
  > {
    if (!this.pool) throw new Error('Database not initialized');

    const conditions = ['pattern = $1', 'timestamp >= $2', 'timestamp <= $3'];
    const params: any[] = [pattern, startTime, endTime];

    if (connectionId) {
      conditions.push('connection_id = $4');
      params.push(connectionId);
    }

    const result = await this.pool.query(
      `
      SELECT timestamp, key_count, total_memory_bytes, stale_key_count
      FROM key_pattern_snapshots
      WHERE ${conditions.join(' AND ')}
      ORDER BY timestamp ASC
    `,
      params,
    );

    return result.rows.map((row) => ({
      timestamp: parseInt(row.timestamp),
      keyCount: row.key_count,
      memoryBytes: parseInt(row.total_memory_bytes),
      staleCount: row.stale_key_count ?? 0,
    }));
  }

  async pruneOldKeyPatternSnapshots(
    cutoffTimestamp: number,
    connectionId?: string,
  ): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM key_pattern_snapshots WHERE timestamp < $1 AND connection_id = $2',
        [cutoffTimestamp, connectionId],
      );
      return result.rowCount ?? 0;
    }

    const result = await this.pool.query('DELETE FROM key_pattern_snapshots WHERE timestamp < $1', [
      cutoffTimestamp,
    ]);

    return result.rowCount ?? 0;
  }

  async saveHotKeys(entries: HotKeyEntry[], connectionId: string): Promise<number> {
    if (!this.pool || entries.length === 0) return 0;

    const values: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    for (const entry of entries) {
      values.push(
        `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`,
      );
      params.push(
        entry.id,
        entry.keyName,
        connectionId,
        entry.capturedAt,
        entry.signalType,
        entry.freqScore ?? null,
        entry.idleSeconds ?? null,
        entry.memoryBytes ?? null,
        entry.cardinality ?? null,
        entry.keyType ?? null,
        entry.ttl ?? null,
        entry.rank,
      );
    }

    await this.pool.query(
      `
      INSERT INTO hot_key_stats (
        id, key_name, connection_id, captured_at, signal_type,
        freq_score, idle_seconds, memory_bytes, cardinality, key_type, ttl, rank
      ) VALUES ${values.join(', ')}
    `,
      params,
    );

    return entries.length;
  }

  async getHotKeys(options: HotKeyQueryOptions = {}): Promise<HotKeyEntry[]> {
    if (!this.pool) throw new Error('Database not initialized');

    // Default to access signals so legacy callers never surface cardinality (largest-key) rows.
    const signalTypes = options.signalTypes ?? ['lfu', 'idletime'];

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    const signalPlaceholders = signalTypes.map(() => `$${paramIndex++}`).join(', ');
    conditions.push(`signal_type IN (${signalPlaceholders})`);
    params.push(...signalTypes);
    if (options.connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(options.connectionId);
    }
    if (options.startTime) {
      conditions.push(`captured_at >= $${paramIndex++}`);
      params.push(options.startTime);
    }
    if (options.endTime) {
      conditions.push(`captured_at <= $${paramIndex++}`);
      params.push(options.endTime);
    }
    if (options.latest || options.oldest) {
      const agg = options.latest ? 'MAX' : 'MIN';
      const subSignalPlaceholders = signalTypes.map(() => `$${paramIndex++}`).join(', ');
      const subConditions: string[] = [`signal_type IN (${subSignalPlaceholders})`];
      params.push(...signalTypes);
      if (options.connectionId) {
        subConditions.push(`connection_id = $${paramIndex++}`);
        params.push(options.connectionId);
      }
      if (options.startTime) {
        subConditions.push(`captured_at >= $${paramIndex++}`);
        params.push(options.startTime);
      }
      if (options.endTime) {
        subConditions.push(`captured_at <= $${paramIndex++}`);
        params.push(options.endTime);
      }
      const subWhere = subConditions.length > 0 ? `WHERE ${subConditions.join(' AND ')}` : '';
      conditions.push(`captured_at = (SELECT ${agg}(captured_at) FROM hot_key_stats ${subWhere})`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    const result = await this.pool.query(
      `
      SELECT id, key_name, connection_id, captured_at, signal_type,
             freq_score, idle_seconds, memory_bytes, cardinality, key_type, ttl, rank
      FROM hot_key_stats
      ${whereClause}
      ORDER BY captured_at DESC, rank ASC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `,
      [...params, limit, offset],
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      keyName: row.key_name,
      connectionId: row.connection_id,
      capturedAt: parseInt(row.captured_at),
      signalType: row.signal_type,
      freqScore: row.freq_score ?? undefined,
      idleSeconds: row.idle_seconds ?? undefined,
      memoryBytes: row.memory_bytes ?? undefined,
      cardinality: row.cardinality != null ? parseInt(row.cardinality) : undefined,
      keyType: row.key_type ?? undefined,
      ttl: row.ttl ?? undefined,
      rank: row.rank,
    }));
  }

  async pruneOldHotKeys(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM hot_key_stats WHERE captured_at < $1 AND connection_id = $2',
        [cutoffTimestamp, connectionId],
      );
      return result.rowCount ?? 0;
    }

    const result = await this.pool.query('DELETE FROM hot_key_stats WHERE captured_at < $1', [
      cutoffTimestamp,
    ]);
    return result.rowCount ?? 0;
  }

  async getSettings(): Promise<AppSettings | null> {
    if (!this.pool) throw new Error('Database not initialized');

    const result = await this.pool.query('SELECT * FROM app_settings WHERE id = 1');

    if (result.rows.length === 0) {
      return null;
    }

    return this.mappers.mapSettingsRow(result.rows[0]);
  }

  async saveSettings(settings: AppSettings): Promise<AppSettings> {
    if (!this.pool) throw new Error('Database not initialized');

    const now = Date.now();
    await this.pool.query(
      `INSERT INTO app_settings (
        id, audit_poll_interval_ms, client_analytics_poll_interval_ms,
        anomaly_poll_interval_ms, anomaly_cache_ttl_ms, anomaly_prometheus_interval_ms,
        throughput_forecasting_enabled, throughput_forecasting_default_rolling_window_ms, throughput_forecasting_default_alert_threshold_ms,
        inference_sla_config,
        updated_at, created_at
      ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT(id) DO UPDATE SET
        audit_poll_interval_ms = EXCLUDED.audit_poll_interval_ms,
        client_analytics_poll_interval_ms = EXCLUDED.client_analytics_poll_interval_ms,
        anomaly_poll_interval_ms = EXCLUDED.anomaly_poll_interval_ms,
        anomaly_cache_ttl_ms = EXCLUDED.anomaly_cache_ttl_ms,
        anomaly_prometheus_interval_ms = EXCLUDED.anomaly_prometheus_interval_ms,
        throughput_forecasting_enabled = EXCLUDED.throughput_forecasting_enabled,
        throughput_forecasting_default_rolling_window_ms = EXCLUDED.throughput_forecasting_default_rolling_window_ms,
        throughput_forecasting_default_alert_threshold_ms = EXCLUDED.throughput_forecasting_default_alert_threshold_ms,
        inference_sla_config = EXCLUDED.inference_sla_config,
        updated_at = EXCLUDED.updated_at`,
      [
        settings.auditPollIntervalMs,
        settings.clientAnalyticsPollIntervalMs,
        settings.anomalyPollIntervalMs,
        settings.anomalyCacheTtlMs,
        settings.anomalyPrometheusIntervalMs,
        settings.metricForecastingEnabled,
        settings.metricForecastingDefaultRollingWindowMs,
        settings.metricForecastingDefaultAlertThresholdMs,
        JSON.stringify(settings.inferenceSlaConfig ?? {}),
        now,
        settings.createdAt || now,
      ],
    );

    const saved = await this.getSettings();
    if (!saved) {
      throw new Error('Failed to save settings');
    }
    return saved;
  }

  async updateSettings(updates: SettingsUpdateRequest): Promise<AppSettings> {
    if (!this.pool) throw new Error('Database not initialized');

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
    if (!this.pool) throw new Error('Database not initialized');
    return this.webhookRepo.createWebhook(webhook);
  }

  async getWebhook(id: string): Promise<Webhook | null> {
    if (!this.pool) throw new Error('Database not initialized');
    return this.webhookRepo.getWebhook(id);
  }

  async getWebhooksByInstance(connectionId?: string): Promise<Webhook[]> {
    if (!this.pool) throw new Error('Database not initialized');
    return this.webhookRepo.getWebhooksByInstance(connectionId);
  }

  async getWebhooksByEvent(event: WebhookEventType, connectionId?: string): Promise<Webhook[]> {
    if (!this.pool) throw new Error('Database not initialized');
    return this.webhookRepo.getWebhooksByEvent(event, connectionId);
  }

  async updateWebhook(
    id: string,
    updates: Partial<Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<Webhook | null> {
    if (!this.pool) throw new Error('Database not initialized');
    return this.webhookRepo.updateWebhook(id, updates);
  }

  async deleteWebhook(id: string): Promise<boolean> {
    if (!this.pool) throw new Error('Database not initialized');
    return this.webhookRepo.deleteWebhook(id);
  }

  async createDelivery(
    delivery: Omit<WebhookDelivery, 'id' | 'createdAt'>,
  ): Promise<WebhookDelivery> {
    if (!this.pool) throw new Error('Database not initialized');
    return this.webhookRepo.createDelivery(delivery);
  }

  async getDelivery(id: string): Promise<WebhookDelivery | null> {
    if (!this.pool) throw new Error('Database not initialized');
    return this.webhookRepo.getDelivery(id);
  }

  async getDeliveriesByWebhook(
    webhookId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<WebhookDelivery[]> {
    if (!this.pool) throw new Error('Database not initialized');
    return this.webhookRepo.getDeliveriesByWebhook(webhookId, limit, offset);
  }

  async updateDelivery(
    id: string,
    updates: Partial<Omit<WebhookDelivery, 'id' | 'webhookId' | 'createdAt'>>,
  ): Promise<boolean> {
    if (!this.pool) throw new Error('Database not initialized');
    return this.webhookRepo.updateDelivery(id, updates);
  }

  async getRetriableDeliveries(
    limit: number = 100,
    connectionId?: string,
  ): Promise<WebhookDelivery[]> {
    if (!this.pool) throw new Error('Database not initialized');
    return this.webhookRepo.getRetriableDeliveries(limit, connectionId);
  }

  async pruneOldDeliveries(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');
    return this.webhookRepo.pruneOldDeliveries(cutoffTimestamp, connectionId);
  }

  // Slow Log Methods
  async saveSlowLogEntries(entries: StoredSlowLogEntry[], connectionId: string): Promise<number> {
    if (!this.pool || entries.length === 0) return 0;
    return this.slowlogRepo.saveSlowLogEntries(entries, connectionId);
  }

  async getSlowLogEntries(options: SlowLogQueryOptions = {}): Promise<StoredSlowLogEntry[]> {
    if (!this.pool) throw new Error('Database not initialized');
    return this.slowlogRepo.getSlowLogEntries(options);
  }

  async getLatestSlowLogId(connectionId?: string): Promise<number | null> {
    if (!this.pool) throw new Error('Database not initialized');
    return this.slowlogRepo.getLatestSlowLogId(connectionId);
  }

  async pruneOldSlowLogEntries(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');
    return this.slowlogRepo.pruneOldSlowLogEntries(cutoffTimestamp, connectionId);
  }

  // Command Log Methods (Valkey-specific)
  async saveCommandLogEntries(
    entries: StoredCommandLogEntry[],
    connectionId: string,
  ): Promise<number> {
    if (!this.pool || entries.length === 0) return 0;

    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const entry of entries) {
      placeholders.push(`(
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}
      )`);
      values.push(
        entry.id,
        entry.timestamp,
        entry.duration,
        entry.command,
        entry.clientAddress || '',
        entry.clientName || '',
        entry.type,
        entry.capturedAt,
        entry.sourceHost,
        entry.sourcePort,
        connectionId,
      );
    }

    const query = `
      INSERT INTO command_log_entries (
        commandlog_id, timestamp, duration, command,
        client_address, client_name, log_type, captured_at, source_host, source_port, connection_id
      ) VALUES ${placeholders.join(', ')}
      ON CONFLICT (commandlog_id, log_type, source_host, source_port, connection_id) DO NOTHING
    `;

    const result = await this.pool.query(query, values);
    return result.rowCount ?? 0;
  }

  async getCommandLogEntries(
    options: CommandLogQueryOptions = {},
  ): Promise<StoredCommandLogEntry[]> {
    if (!this.pool) throw new Error('Database not initialized');

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (options.connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(options.connectionId);
    }
    if (options.startTime) {
      conditions.push(`timestamp >= $${paramIndex++}`);
      params.push(options.startTime);
    }
    if (options.endTime) {
      conditions.push(`timestamp <= $${paramIndex++}`);
      params.push(options.endTime);
    }
    if (options.command) {
      conditions.push(`command[1] ILIKE $${paramIndex++}`);
      params.push(`%${options.command}%`);
    }
    if (options.clientName) {
      conditions.push(`client_name ILIKE $${paramIndex++}`);
      params.push(`%${options.clientName}%`);
    }
    if (options.type) {
      conditions.push(`log_type = $${paramIndex++}`);
      params.push(options.type);
    }
    if (options.minDuration) {
      conditions.push(`duration >= $${paramIndex++}`);
      params.push(options.minDuration);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const result = await this.pool.query(
      `SELECT
        commandlog_id, timestamp, duration, command,
        client_address, client_name, log_type, captured_at, source_host, source_port, connection_id
      FROM command_log_entries
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset],
    );

    return result.rows.map((row) => this.mappers.mapCommandLogEntryRow(row));
  }

  async getLatestCommandLogId(type: CommandLogType, connectionId?: string): Promise<number | null> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        'SELECT MAX(commandlog_id) as max_id FROM command_log_entries WHERE log_type = $1 AND connection_id = $2',
        [type, connectionId],
      );
      const maxId = result.rows[0]?.max_id;
      return maxId !== null && maxId !== undefined ? Number(maxId) : null;
    }

    const result = await this.pool.query(
      'SELECT MAX(commandlog_id) as max_id FROM command_log_entries WHERE log_type = $1',
      [type],
    );

    const maxId = result.rows[0]?.max_id;
    return maxId !== null && maxId !== undefined ? Number(maxId) : null;
  }

  async pruneOldCommandLogEntries(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM command_log_entries WHERE captured_at < $1 AND connection_id = $2',
        [cutoffTimestamp, connectionId],
      );
      return result.rowCount ?? 0;
    }

    const result = await this.pool.query('DELETE FROM command_log_entries WHERE captured_at < $1', [
      cutoffTimestamp,
    ]);

    return result.rowCount ?? 0;
  }

  // Latency Snapshot Methods
  async saveLatencySnapshots(
    snapshots: StoredLatencySnapshot[],
    connectionId: string,
  ): Promise<number> {
    if (!this.pool || snapshots.length === 0) return 0;

    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const snapshot of snapshots) {
      placeholders.push(`(
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}
      )`);
      values.push(
        snapshot.id,
        snapshot.timestamp,
        snapshot.eventName,
        snapshot.latestEventTimestamp,
        snapshot.maxLatency,
        connectionId,
      );
    }

    const query = `
      INSERT INTO latency_snapshots (
        id, timestamp, event_name, latest_event_timestamp, max_latency, connection_id
      ) VALUES ${placeholders.join(', ')}
    `;

    const result = await this.pool.query(query, values);
    return result.rowCount ?? 0;
  }

  async getLatencySnapshots(
    options: LatencySnapshotQueryOptions = {},
  ): Promise<StoredLatencySnapshot[]> {
    if (!this.pool) throw new Error('Database not initialized');

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (options.connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(options.connectionId);
    }
    if (options.startTime) {
      conditions.push(`timestamp >= $${paramIndex++}`);
      params.push(options.startTime);
    }
    if (options.endTime) {
      conditions.push(`timestamp <= $${paramIndex++}`);
      params.push(options.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const query = `
      SELECT id, timestamp, event_name, latest_event_timestamp, max_latency, connection_id
      FROM latency_snapshots
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    params.push(limit, offset);

    const result = await this.pool.query(query, params);
    return result.rows.map((row: any) => ({
      id: row.id,
      timestamp: Number(row.timestamp),
      eventName: row.event_name,
      latestEventTimestamp: Number(row.latest_event_timestamp),
      maxLatency: Number(row.max_latency),
      connectionId: row.connection_id,
    }));
  }

  async pruneOldLatencySnapshots(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM latency_snapshots WHERE timestamp < $1 AND connection_id = $2',
        [cutoffTimestamp, connectionId],
      );
      return result.rowCount ?? 0;
    }

    const result = await this.pool.query('DELETE FROM latency_snapshots WHERE timestamp < $1', [
      cutoffTimestamp,
    ]);
    return result.rowCount ?? 0;
  }

  // Latency Histogram Methods
  async saveLatencyHistogram(
    histogram: StoredLatencyHistogram,
    connectionId: string,
  ): Promise<number> {
    if (!this.pool) return 0;

    const result = await this.pool.query(
      `INSERT INTO latency_histograms (id, timestamp, histogram_data, connection_id)
       VALUES ($1, $2, $3, $4)`,
      [histogram.id, histogram.timestamp, JSON.stringify(histogram.data), connectionId],
    );
    return result.rowCount ?? 0;
  }

  async getLatencyHistograms(
    options: { connectionId?: string; startTime?: number; endTime?: number; limit?: number } = {},
  ): Promise<StoredLatencyHistogram[]> {
    if (!this.pool) throw new Error('Database not initialized');

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (options.connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(options.connectionId);
    }
    if (options.startTime) {
      conditions.push(`timestamp >= $${paramIndex++}`);
      params.push(options.startTime);
    }
    if (options.endTime) {
      conditions.push(`timestamp <= $${paramIndex++}`);
      params.push(options.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 1;

    const query = `
      SELECT id, timestamp, histogram_data, connection_id
      FROM latency_histograms
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT $${paramIndex++}
    `;
    params.push(limit);

    const result = await this.pool.query(query, params);
    return result.rows.map((row: any) => ({
      id: row.id,
      timestamp: Number(row.timestamp),
      data:
        typeof row.histogram_data === 'string'
          ? JSON.parse(row.histogram_data)
          : row.histogram_data,
      connectionId: row.connection_id,
    }));
  }

  async pruneOldLatencyHistograms(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM latency_histograms WHERE timestamp < $1 AND connection_id = $2',
        [cutoffTimestamp, connectionId],
      );
      return result.rowCount ?? 0;
    }

    const result = await this.pool.query('DELETE FROM latency_histograms WHERE timestamp < $1', [
      cutoffTimestamp,
    ]);
    return result.rowCount ?? 0;
  }

  // Memory Snapshot Methods
  async saveMemorySnapshots(
    snapshots: StoredMemorySnapshot[],
    connectionId: string,
  ): Promise<number> {
    if (!this.pool || snapshots.length === 0) return 0;

    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const snapshot of snapshots) {
      placeholders.push(`(
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
        $${paramIndex++}, $${paramIndex++}
      )`);
      values.push(
        snapshot.id,
        snapshot.timestamp,
        snapshot.usedMemory,
        snapshot.usedMemoryRss,
        snapshot.usedMemoryPeak,
        snapshot.memFragmentationRatio,
        snapshot.maxmemory,
        snapshot.allocatorFragRatio,
        snapshot.opsPerSec ?? 0,
        snapshot.cpuSys ?? 0,
        snapshot.cpuUser ?? 0,
        snapshot.ioThreadedReads ?? 0,
        snapshot.ioThreadedWrites ?? 0,
        connectionId,
      );
    }

    const query = `
      INSERT INTO memory_snapshots (
        id, timestamp, used_memory, used_memory_rss, used_memory_peak,
        mem_fragmentation_ratio, maxmemory, allocator_frag_ratio,
        ops_per_sec, cpu_sys, cpu_user, io_threaded_reads, io_threaded_writes, connection_id
      ) VALUES ${placeholders.join(', ')}
    `;

    const result = await this.pool.query(query, values);
    return result.rowCount ?? 0;
  }

  async getMemorySnapshots(
    options: MemorySnapshotQueryOptions = {},
  ): Promise<StoredMemorySnapshot[]> {
    if (!this.pool) throw new Error('Database not initialized');

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (options.connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(options.connectionId);
    }
    if (options.startTime) {
      conditions.push(`timestamp >= $${paramIndex++}`);
      params.push(options.startTime);
    }
    if (options.endTime) {
      conditions.push(`timestamp <= $${paramIndex++}`);
      params.push(options.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const query = `
      SELECT id, timestamp, used_memory, used_memory_rss, used_memory_peak,
             mem_fragmentation_ratio, maxmemory, allocator_frag_ratio,
             ops_per_sec, cpu_sys, cpu_user, io_threaded_reads, io_threaded_writes, connection_id
      FROM memory_snapshots
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    params.push(limit, offset);

    const result = await this.pool.query(query, params);
    return result.rows.map((row: any) => ({
      id: row.id,
      timestamp: Number(row.timestamp),
      usedMemory: Number(row.used_memory),
      usedMemoryRss: Number(row.used_memory_rss),
      usedMemoryPeak: Number(row.used_memory_peak),
      memFragmentationRatio: Number(row.mem_fragmentation_ratio),
      maxmemory: Number(row.maxmemory),
      allocatorFragRatio: Number(row.allocator_frag_ratio),
      opsPerSec: Number(row.ops_per_sec ?? 0),
      cpuSys: Number(row.cpu_sys ?? 0),
      cpuUser: Number(row.cpu_user ?? 0),
      ioThreadedReads: Number(row.io_threaded_reads ?? 0),
      ioThreadedWrites: Number(row.io_threaded_writes ?? 0),
      connectionId: row.connection_id,
    }));
  }

  async pruneOldMemorySnapshots(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM memory_snapshots WHERE timestamp < $1 AND connection_id = $2',
        [cutoffTimestamp, connectionId],
      );
      return result.rowCount ?? 0;
    }

    const result = await this.pool.query('DELETE FROM memory_snapshots WHERE timestamp < $1', [
      cutoffTimestamp,
    ]);
    return result.rowCount ?? 0;
  }

  // Command Stats Sample Methods
  async saveCommandStatsSamples(
    samples: Omit<StoredCommandStatsSample, 'id' | 'connectionId'>[],
    connectionId: string,
  ): Promise<number> {
    if (!this.pool || samples.length === 0) return 0;

    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const s of samples) {
      const row: string[] = [];
      for (let i = 0; i < 12; i++) {
        row.push(`$${paramIndex++}`);
      }
      placeholders.push(`(${row.join(', ')})`);
      values.push(
        randomUUID(),
        connectionId,
        s.command,
        s.callsTotal,
        s.usecTotal,
        s.usecPerCall,
        s.rejectedCalls,
        s.failedCalls,
        s.callsDelta,
        s.usecDelta,
        s.intervalMs,
        s.capturedAt,
      );
    }

    const query = `
      INSERT INTO command_stats_samples
        (id, connection_id, command,
         calls_total, usec_total, usec_per_call, rejected_calls, failed_calls,
         calls_delta, usec_delta, interval_ms, captured_at)
      VALUES ${placeholders.join(', ')}
    `;
    const result = await this.pool.query(query, values);
    return result.rowCount ?? 0;
  }

  async getCommandStatsHistory(
    options: CommandStatsHistoryQueryOptions,
  ): Promise<StoredCommandStatsSample[]> {
    if (!this.pool) throw new Error('Database not initialized');

    const result = await this.pool.query(
      `SELECT id, connection_id, command,
              calls_total, usec_total, usec_per_call, rejected_calls, failed_calls,
              calls_delta, usec_delta, interval_ms, captured_at
       FROM command_stats_samples
       WHERE connection_id = $1 AND command = $2 AND captured_at >= $3 AND captured_at <= $4
       ORDER BY captured_at ASC
       LIMIT $5`,
      [
        options.connectionId,
        options.command,
        options.startTime,
        options.endTime,
        options.limit ?? 10_000,
      ],
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      connectionId: row.connection_id,
      command: row.command,
      callsTotal: Number(row.calls_total),
      usecTotal: Number(row.usec_total),
      usecPerCall: Number(row.usec_per_call),
      rejectedCalls: Number(row.rejected_calls),
      failedCalls: Number(row.failed_calls),
      callsDelta: Number(row.calls_delta),
      usecDelta: Number(row.usec_delta),
      intervalMs: Number(row.interval_ms),
      capturedAt: Number(row.captured_at),
    }));
  }

  async pruneOldCommandStatsSamples(
    cutoffTimestamp: number,
    connectionId?: string,
  ): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM command_stats_samples WHERE captured_at < $1 AND connection_id = $2',
        [cutoffTimestamp, connectionId],
      );
      return result.rowCount ?? 0;
    }

    const result = await this.pool.query(
      'DELETE FROM command_stats_samples WHERE captured_at < $1',
      [cutoffTimestamp],
    );
    return result.rowCount ?? 0;
  }

  // Latency Stats Sample Methods (INFO latencystats)
  async saveLatencyStatsSamples(
    samples: Omit<StoredLatencyStatsSample, 'id' | 'connectionId'>[],
    connectionId: string,
  ): Promise<number> {
    if (!this.pool || samples.length === 0) return 0;

    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const s of samples) {
      const row: string[] = [];
      for (let i = 0; i < 8; i++) {
        row.push(`$${paramIndex++}`);
      }
      placeholders.push(`(${row.join(', ')})`);
      values.push(
        randomUUID(),
        connectionId,
        s.command,
        s.p50Us,
        s.p99Us,
        s.p999Us,
        s.serverVersion,
        s.capturedAt,
      );
    }

    const query = `
      INSERT INTO latency_stats_samples
        (id, connection_id, command, p50_us, p99_us, p999_us, server_version, captured_at)
      VALUES ${placeholders.join(', ')}
    `;
    const result = await this.pool.query(query, values);
    return result.rowCount ?? 0;
  }

  async getLatencyStatsHistory(
    options: LatencyStatsHistoryQueryOptions,
  ): Promise<StoredLatencyStatsSample[]> {
    if (!this.pool) throw new Error('Database not initialized');

    const params: (string | number)[] = [options.connectionId];
    let commandFilter = '';
    if (options.command) {
      params.push(options.command);
      commandFilter = `AND command = $${params.length}`;
    }
    params.push(options.startTime, options.endTime, options.limit ?? 10_000);
    const startIdx = params.length - 2;

    // Keep the most-recent `limit` rows PER COMMAND (ROW_NUMBER partitioned by command), then
    // return them ascending. A single global LIMIT would split its budget across all commands,
    // starving per-command baselines on busy instances; DESC inside the partition keeps the
    // newest rows (the guard relies on freshness/version/consecutive logic). With a command
    // filter the partition is that one command, so behaviour is unchanged.
    const result = await this.pool.query(
      `SELECT id, connection_id, command, p50_us, p99_us, p999_us, server_version, captured_at
       FROM (
         SELECT id, connection_id, command, p50_us, p99_us, p999_us, server_version, captured_at,
                ROW_NUMBER() OVER (PARTITION BY command ORDER BY captured_at DESC) AS rn
         FROM latency_stats_samples
         WHERE connection_id = $1 ${commandFilter} AND captured_at >= $${startIdx} AND captured_at <= $${startIdx + 1}
       ) ranked
       WHERE rn <= $${startIdx + 2}
       ORDER BY captured_at ASC`,
      params,
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      connectionId: row.connection_id,
      command: row.command,
      p50Us: Number(row.p50_us),
      p99Us: Number(row.p99_us),
      p999Us: Number(row.p999_us),
      serverVersion: row.server_version,
      capturedAt: Number(row.captured_at),
    }));
  }

  async pruneOldLatencyStatsSamples(
    cutoffTimestamp: number,
    connectionId?: string,
  ): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM latency_stats_samples WHERE captured_at < $1 AND connection_id = $2',
        [cutoffTimestamp, connectionId],
      );
      return result.rowCount ?? 0;
    }

    const result = await this.pool.query(
      'DELETE FROM latency_stats_samples WHERE captured_at < $1',
      [cutoffTimestamp],
    );
    return result.rowCount ?? 0;
  }

  // AI Cache/Memory Sample Methods
  async saveAiCacheSamples(
    samples: Omit<StoredAiCacheSample, 'id' | 'connectionId'>[],
    connectionId: string,
  ): Promise<number> {
    if (!this.pool || samples.length === 0) return 0;

    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const s of samples) {
      const row: string[] = [];
      for (let i = 0; i < 15; i++) {
        row.push(`$${paramIndex++}`);
      }
      placeholders.push(`(${row.join(', ')})`);
      values.push(
        randomUUID(),
        connectionId,
        s.instanceField,
        s.instanceName,
        s.kind,
        s.timestamp,
        s.hits,
        s.misses,
        s.hitRate,
        s.costSavedMicros,
        s.evictions,
        s.items,
        s.indexBytes,
        s.threshold,
        s.extra,
      );
    }

    const query = `
      INSERT INTO ai_cache_samples
        (id, connection_id, instance_field, instance_name, kind, timestamp,
         hits, misses, hit_rate, cost_saved_micros, evictions, items, index_bytes, threshold, extra)
      VALUES ${placeholders.join(', ')}
    `;
    const result = await this.pool.query(query, values);
    return result.rowCount ?? 0;
  }

  async getAiCacheHistory(
    options: AiCacheHistoryQueryOptions,
  ): Promise<StoredAiCacheSample[]> {
    if (!this.pool) throw new Error('Database not initialized');

    const filters: string[] = [];
    const params: (string | number)[] = [];
    if (options.connectionId) {
      params.push(options.connectionId);
      filters.push(`connection_id = $${params.length}`);
    }
    if (options.instanceField) {
      params.push(options.instanceField);
      filters.push(`instance_field = $${params.length}`);
    }
    if (options.kind) {
      params.push(options.kind);
      filters.push(`kind = $${params.length}`);
    }
    if (options.startTime !== undefined) {
      params.push(options.startTime);
      filters.push(`timestamp >= $${params.length}`);
    }
    if (options.endTime !== undefined) {
      params.push(options.endTime);
      filters.push(`timestamp <= $${params.length}`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    params.push(options.limit ?? 10_000);
    const limitIdx = params.length;

    // Most-recent `limit` rows PER INSTANCE, returned ascending (see latency_stats_samples).
    const result = await this.pool.query(
      `SELECT id, connection_id, instance_field, instance_name, kind, timestamp,
              hits, misses, hit_rate, cost_saved_micros, evictions, items, index_bytes, threshold, extra
       FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY instance_field ORDER BY timestamp DESC) AS rn
         FROM ai_cache_samples
         ${where}
       ) ranked
       WHERE rn <= $${limitIdx}
       ORDER BY timestamp ASC`,
      params,
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      connectionId: row.connection_id,
      instanceField: row.instance_field,
      instanceName: row.instance_name,
      kind: row.kind,
      timestamp: Number(row.timestamp),
      hits: Number(row.hits),
      misses: Number(row.misses),
      hitRate: row.hit_rate === null ? null : Number(row.hit_rate),
      costSavedMicros: Number(row.cost_saved_micros),
      evictions: Number(row.evictions),
      items: row.items === null ? null : Number(row.items),
      indexBytes: row.index_bytes === null ? null : Number(row.index_bytes),
      threshold: row.threshold === null ? null : Number(row.threshold),
      extra: row.extra,
    }));
  }

  async pruneOldAiCacheSamples(
    cutoffTimestamp: number,
    connectionId?: string,
  ): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM ai_cache_samples WHERE timestamp < $1 AND connection_id = $2',
        [cutoffTimestamp, connectionId],
      );
      return result.rowCount ?? 0;
    }

    const result = await this.pool.query(
      'DELETE FROM ai_cache_samples WHERE timestamp < $1',
      [cutoffTimestamp],
    );
    return result.rowCount ?? 0;
  }

  // OTLP Trace Methods
  async saveOtelSpans(spans: StoredOtelSpan[]): Promise<number> {
    if (!this.pool || spans.length === 0) return 0;

    const values: any[] = [];
    const placeholders: string[] = [];
    let p = 1;
    for (const s of spans) {
      const row: string[] = [];
      for (let i = 0; i < 15; i++) row.push(`$${p++}`);
      placeholders.push(`(${row.join(', ')})`);
      values.push(
        s.traceId,
        s.spanId,
        s.parentSpanId,
        s.name,
        s.scopeName,
        s.serviceName,
        s.kind,
        s.startTimeUnixNano,
        s.endTimeUnixNano,
        s.startTimeMs,
        s.durationNs,
        s.statusCode,
        s.statusMessage,
        s.attributes,
        s.ingestedAt,
      );
    }

    const query = `
      INSERT INTO otel_spans
        (trace_id, span_id, parent_span_id, name, scope_name, service_name, kind,
         start_time_unix_nano, end_time_unix_nano, start_time_ms, duration_ns,
         status_code, status_message, attributes, ingested_at)
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (trace_id, span_id) DO UPDATE SET
        parent_span_id = EXCLUDED.parent_span_id,
        name = EXCLUDED.name,
        scope_name = EXCLUDED.scope_name,
        service_name = EXCLUDED.service_name,
        kind = EXCLUDED.kind,
        start_time_unix_nano = EXCLUDED.start_time_unix_nano,
        end_time_unix_nano = EXCLUDED.end_time_unix_nano,
        start_time_ms = EXCLUDED.start_time_ms,
        duration_ns = EXCLUDED.duration_ns,
        status_code = EXCLUDED.status_code,
        status_message = EXCLUDED.status_message,
        attributes = EXCLUDED.attributes,
        ingested_at = EXCLUDED.ingested_at
    `;
    const result = await this.pool.query(query, values);
    return result.rowCount ?? 0;
  }

  async getOtelTraces(options: OtelTraceQueryOptions): Promise<OtelTraceSummary[]> {
    if (!this.pool) throw new Error('Database not initialized');

    // Filter whole traces by their trace-level start / service (subquery on
    // grouped traces), then aggregate ALL spans of the matching traces, so a
    // boundary trace still gets a complete summary rather than a partial one.
    const having: string[] = [];
    const params: (string | number)[] = [];
    if (options.startTime !== undefined) {
      params.push(options.startTime);
      having.push(`MIN(start_time_ms) >= $${params.length}`);
    }
    if (options.endTime !== undefined) {
      params.push(options.endTime);
      having.push(`MIN(start_time_ms) <= $${params.length}`);
    }
    if (options.service) {
      params.push(options.service);
      having.push(`SUM(CASE WHEN service_name = $${params.length} THEN 1 ELSE 0 END) > 0`);
    }
    const traceFilter = having.length
      ? `WHERE trace_id IN (SELECT trace_id FROM otel_spans GROUP BY trace_id HAVING ${having.join(' AND ')})`
      : '';
    params.push(options.limit ?? 100);

    const result = await this.pool.query(
      `SELECT
         trace_id,
         MIN(start_time_ms) AS start_time_ms,
         COUNT(*) AS span_count,
         SUM(CASE WHEN scope_name LIKE '@betterdb/%' THEN 1 ELSE 0 END) AS betterdb_span_count,
         BOOL_OR(status_code = 2) AS has_error,
         MAX(CASE WHEN parent_span_id IS NULL THEN name END) AS root_name,
         COALESCE(
           MAX(CASE WHEN parent_span_id IS NULL THEN service_name END),
           MAX(service_name)
         ) AS service_name,
         COALESCE(
           MAX(CASE WHEN parent_span_id IS NULL THEN duration_ns END),
           (MAX(start_time_ms + duration_ns / 1000000) - MIN(start_time_ms)) * 1000000
         ) AS duration_ns
       FROM otel_spans
       ${traceFilter}
       GROUP BY trace_id
       ORDER BY start_time_ms DESC
       LIMIT $${params.length}`,
      params,
    );

    return result.rows.map((row: any) => ({
      traceId: row.trace_id,
      rootName: row.root_name ?? null,
      serviceName: row.service_name ?? null,
      startTimeMs: Number(row.start_time_ms),
      durationNs: Number(row.duration_ns ?? 0),
      spanCount: Number(row.span_count),
      betterdbSpanCount: Number(row.betterdb_span_count),
      hasError: row.has_error === true,
    }));
  }

  async getOtelTraceSpans(traceId: string): Promise<StoredOtelSpan[]> {
    if (!this.pool) throw new Error('Database not initialized');
    const result = await this.pool.query(
      `SELECT * FROM otel_spans WHERE trace_id = $1
       ORDER BY start_time_ms ASC, start_time_unix_nano ASC`,
      [traceId],
    );
    return result.rows.map((row: any) => ({
      traceId: row.trace_id,
      spanId: row.span_id,
      parentSpanId: row.parent_span_id ?? null,
      name: row.name,
      scopeName: row.scope_name,
      serviceName: row.service_name ?? null,
      kind: Number(row.kind),
      startTimeUnixNano: row.start_time_unix_nano,
      endTimeUnixNano: row.end_time_unix_nano,
      startTimeMs: Number(row.start_time_ms),
      durationNs: Number(row.duration_ns),
      statusCode: Number(row.status_code),
      statusMessage: row.status_message ?? null,
      attributes: row.attributes,
      ingestedAt: Number(row.ingested_at),
    }));
  }

  async pruneOldOtelSpans(cutoffTimestamp: number): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');
    // Prune whole traces (by trace-level start), not individual spans, so a long
    // trace never loses its root/early spans while later ones survive.
    const result = await this.pool.query(
      `DELETE FROM otel_spans WHERE trace_id IN (
         SELECT trace_id FROM otel_spans GROUP BY trace_id HAVING MIN(start_time_ms) < $1
       )`,
      [cutoffTimestamp],
    );
    return result.rowCount ?? 0;
  }

  // Vector Index Snapshot Methods
  async saveVectorIndexSnapshots(
    snapshots: VectorIndexSnapshot[],
    connectionId: string,
  ): Promise<number> {
    if (!this.pool || snapshots.length === 0) return 0;

    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const snapshot of snapshots) {
      const placeholderRow: string[] = [];
      for (let i = 0; i < 13; i++) {
        placeholderRow.push(`$${paramIndex++}`);
      }
      placeholders.push(`(${placeholderRow.join(', ')})`);
      values.push(
        snapshot.id,
        snapshot.timestamp,
        connectionId,
        snapshot.indexName,
        snapshot.numDocs,
        snapshot.numRecords,
        snapshot.numDeletedDocs,
        snapshot.indexingFailures,
        snapshot.indexingFailuresDelta,
        snapshot.percentIndexed,
        snapshot.indexingState,
        snapshot.totalIndexingTime,
        snapshot.memorySizeMb,
      );
    }

    const query = `
      INSERT INTO vector_index_snapshots (
        id, timestamp, connection_id, index_name,
        num_docs, num_records, num_deleted_docs,
        indexing_failures, indexing_failures_delta,
        percent_indexed, indexing_state, total_indexing_time,
        memory_size_mb
      )
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (id) DO NOTHING
    `;

    const result = await this.pool.query(query, values);
    return result.rowCount ?? 0;
  }

  async getVectorIndexSnapshots(
    options: VectorIndexSnapshotQueryOptions = {},
  ): Promise<VectorIndexSnapshot[]> {
    if (!this.pool) throw new Error('Database not initialized');

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (options.connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(options.connectionId);
    }
    if (options.indexName) {
      conditions.push(`index_name = $${paramIndex++}`);
      params.push(options.indexName);
    }
    if (options.startTime) {
      conditions.push(`timestamp >= $${paramIndex++}`);
      params.push(options.startTime);
    }
    if (options.endTime) {
      conditions.push(`timestamp <= $${paramIndex++}`);
      params.push(options.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 200;

    const query = `
      SELECT id, timestamp, connection_id, index_name,
             num_docs, num_records, num_deleted_docs,
             indexing_failures, indexing_failures_delta,
             percent_indexed, indexing_state, total_indexing_time,
             memory_size_mb
      FROM vector_index_snapshots
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT $${paramIndex++}
    `;
    params.push(limit);

    const result = await this.pool.query(query, params);
    return result.rows.map((row: any) => ({
      id: row.id,
      timestamp: Number(row.timestamp),
      connectionId: row.connection_id,
      indexName: row.index_name,
      numDocs: Number(row.num_docs),
      numRecords: Number(row.num_records ?? 0),
      numDeletedDocs: Number(row.num_deleted_docs ?? 0),
      indexingFailures: Number(row.indexing_failures ?? 0),
      indexingFailuresDelta: Number(row.indexing_failures_delta ?? 0),
      percentIndexed: Number(row.percent_indexed ?? 0),
      indexingState: row.indexing_state ?? 'indexed',
      totalIndexingTime: Number(row.total_indexing_time ?? 0),
      memorySizeMb: Number(row.memory_size_mb),
    }));
  }

  async pruneOldVectorIndexSnapshots(
    cutoffTimestamp: number,
    connectionId?: string,
  ): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM vector_index_snapshots WHERE timestamp < $1 AND connection_id = $2',
        [cutoffTimestamp, connectionId],
      );
      return result.rowCount ?? 0;
    }

    const result = await this.pool.query(
      'DELETE FROM vector_index_snapshots WHERE timestamp < $1',
      [cutoffTimestamp],
    );
    return result.rowCount ?? 0;
  }

  // Connection Management Methods
  async saveConnection(config: DatabaseConnectionConfig): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    await this.pool.query(
      `
      INSERT INTO connections (id, name, host, port, username, password, password_encrypted, db_index, tls, is_default, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT(id) DO UPDATE SET
        name = EXCLUDED.name,
        host = EXCLUDED.host,
        port = EXCLUDED.port,
        username = EXCLUDED.username,
        password = EXCLUDED.password,
        password_encrypted = EXCLUDED.password_encrypted,
        db_index = EXCLUDED.db_index,
        tls = EXCLUDED.tls,
        is_default = EXCLUDED.is_default,
        updated_at = EXCLUDED.updated_at
    `,
      [
        config.id,
        config.name,
        config.host,
        config.port,
        config.username || null,
        config.password || null,
        config.passwordEncrypted || false,
        config.dbIndex || 0,
        config.tls || false,
        config.isDefault || false,
        config.createdAt,
        config.updatedAt || null,
      ],
    );
  }

  async getConnections(): Promise<DatabaseConnectionConfig[]> {
    if (!this.pool) throw new Error('Database not initialized');

    const result = await this.pool.query('SELECT * FROM connections ORDER BY created_at ASC');

    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      username: row.username || undefined,
      password: row.password || undefined,
      passwordEncrypted: row.password_encrypted || false,
      dbIndex: row.db_index,
      tls: row.tls,
      isDefault: row.is_default,
      createdAt: Number(row.created_at),
      updatedAt: row.updated_at ? Number(row.updated_at) : undefined,
    }));
  }

  async getConnection(id: string): Promise<DatabaseConnectionConfig | null> {
    if (!this.pool) throw new Error('Database not initialized');

    const result = await this.pool.query('SELECT * FROM connections WHERE id = $1', [id]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      username: row.username || undefined,
      password: row.password || undefined,
      passwordEncrypted: row.password_encrypted || false,
      dbIndex: row.db_index,
      tls: row.tls,
      isDefault: row.is_default,
      createdAt: Number(row.created_at),
      updatedAt: row.updated_at ? Number(row.updated_at) : undefined,
    };
  }

  async deleteConnection(id: string): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');
    await this.pool.query('DELETE FROM connections WHERE id = $1', [id]);
  }

  async updateConnection(id: string, updates: Partial<DatabaseConnectionConfig>): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    const setClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      params.push(updates.name);
    }
    if (updates.host !== undefined) {
      setClauses.push(`host = $${paramIndex++}`);
      params.push(updates.host);
    }
    if (updates.port !== undefined) {
      setClauses.push(`port = $${paramIndex++}`);
      params.push(updates.port);
    }
    if (updates.username !== undefined) {
      setClauses.push(`username = $${paramIndex++}`);
      params.push(updates.username);
    }
    if (updates.password !== undefined) {
      setClauses.push(`password = $${paramIndex++}`);
      params.push(updates.password);
    }
    if (updates.dbIndex !== undefined) {
      setClauses.push(`db_index = $${paramIndex++}`);
      params.push(updates.dbIndex);
    }
    if (updates.tls !== undefined) {
      setClauses.push(`tls = $${paramIndex++}`);
      params.push(updates.tls);
    }
    if (updates.isDefault !== undefined) {
      setClauses.push(`is_default = $${paramIndex++}`);
      params.push(updates.isDefault);
    }

    if (setClauses.length === 0) return;

    setClauses.push(`updated_at = $${paramIndex++}`);
    params.push(Date.now());
    params.push(id);

    await this.pool.query(
      `UPDATE connections SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
      params,
    );
  }

  // Agent Token Methods

  async saveAgentToken(token: {
    id: string;
    name: string;
    type: 'agent' | 'mcp';
    tokenHash: string;
    createdAt: number;
    expiresAt: number;
    revokedAt: number | null;
    lastUsedAt: number | null;
  }): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');
    await this.pool.query(
      `INSERT INTO agent_tokens (id, name, type, token_hash, created_at, expires_at, revoked_at, last_used_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         type = EXCLUDED.type,
         token_hash = EXCLUDED.token_hash,
         expires_at = EXCLUDED.expires_at,
         revoked_at = EXCLUDED.revoked_at,
         last_used_at = EXCLUDED.last_used_at`,
      [
        token.id,
        token.name,
        token.type,
        token.tokenHash,
        token.createdAt,
        token.expiresAt,
        token.revokedAt,
        token.lastUsedAt,
      ],
    );
  }

  async getAgentTokens(type?: 'agent' | 'mcp'): Promise<
    Array<{
      id: string;
      name: string;
      type: 'agent' | 'mcp';
      tokenHash: string;
      createdAt: number;
      expiresAt: number;
      revokedAt: number | null;
      lastUsedAt: number | null;
    }>
  > {
    if (!this.pool) throw new Error('Database not initialized');
    const query = type
      ? `SELECT id, name, type, token_hash, created_at, expires_at, revoked_at, last_used_at
         FROM agent_tokens WHERE type = $1 ORDER BY created_at DESC`
      : `SELECT id, name, type, token_hash, created_at, expires_at, revoked_at, last_used_at
         FROM agent_tokens ORDER BY created_at DESC`;
    const result = type ? await this.pool.query(query, [type]) : await this.pool.query(query);
    return result.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      type: row.type || 'agent',
      tokenHash: row.token_hash,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      revokedAt: row.revoked_at ? Number(row.revoked_at) : null,
      lastUsedAt: row.last_used_at ? Number(row.last_used_at) : null,
    }));
  }

  async getAgentTokenByHash(hash: string): Promise<{
    id: string;
    name: string;
    type: 'agent' | 'mcp';
    tokenHash: string;
    createdAt: number;
    expiresAt: number;
    revokedAt: number | null;
    lastUsedAt: number | null;
  } | null> {
    if (!this.pool) throw new Error('Database not initialized');
    const result = await this.pool.query(
      `SELECT id, name, type, token_hash, created_at, expires_at, revoked_at, last_used_at
       FROM agent_tokens WHERE token_hash = $1`,
      [hash],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      type: row.type || 'agent',
      tokenHash: row.token_hash,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      revokedAt: row.revoked_at ? Number(row.revoked_at) : null,
      lastUsedAt: row.last_used_at ? Number(row.last_used_at) : null,
    };
  }

  async revokeAgentToken(id: string): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');
    await this.pool.query(`UPDATE agent_tokens SET revoked_at = $1 WHERE id = $2`, [
      Date.now(),
      id,
    ]);
  }

  async updateAgentTokenLastUsed(id: string): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');
    await this.pool.query(`UPDATE agent_tokens SET last_used_at = $1 WHERE id = $2`, [
      Date.now(),
      id,
    ]);
  }

  // Metric Forecasting Settings

  private mapMetricForecastRow(row: any): MetricForecastSettings {
    return {
      connectionId: row.connection_id,
      metricKind: row.metric_kind as MetricKind,
      enabled: row.enabled,
      ceiling: row.ceiling ?? null,
      rollingWindowMs: row.rolling_window_ms,
      alertThresholdMs: row.alert_threshold_ms,
      updatedAt: Number(row.updated_at),
    };
  }

  async getMetricForecastSettings(
    connectionId: string,
    metricKind: MetricKind,
  ): Promise<MetricForecastSettings | null> {
    if (!this.pool) throw new Error('Database not initialized');
    const result = await this.pool.query(
      'SELECT * FROM metric_forecast_settings WHERE connection_id = $1 AND metric_kind = $2',
      [connectionId, metricKind],
    );
    if (result.rows.length === 0) return null;
    return this.mapMetricForecastRow(result.rows[0]);
  }

  async saveMetricForecastSettings(
    settings: MetricForecastSettings,
  ): Promise<MetricForecastSettings> {
    if (!this.pool) throw new Error('Database not initialized');
    await this.pool.query(
      `
      INSERT INTO metric_forecast_settings
        (connection_id, metric_kind, enabled, ceiling, rolling_window_ms, alert_threshold_ms, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT(connection_id, metric_kind) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        ceiling = EXCLUDED.ceiling,
        rolling_window_ms = EXCLUDED.rolling_window_ms,
        alert_threshold_ms = EXCLUDED.alert_threshold_ms,
        updated_at = EXCLUDED.updated_at
    `,
      [
        settings.connectionId,
        settings.metricKind,
        settings.enabled,
        settings.ceiling,
        settings.rollingWindowMs,
        settings.alertThresholdMs,
        settings.updatedAt,
      ],
    );
    return { ...settings };
  }

  async deleteMetricForecastSettings(
    connectionId: string,
    metricKind: MetricKind,
  ): Promise<boolean> {
    if (!this.pool) throw new Error('Database not initialized');
    const result = await this.pool.query(
      'DELETE FROM metric_forecast_settings WHERE connection_id = $1 AND metric_kind = $2',
      [connectionId, metricKind],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getActiveMetricForecastSettings(): Promise<MetricForecastSettings[]> {
    if (!this.pool) throw new Error('Database not initialized');
    const result = await this.pool.query(
      'SELECT * FROM metric_forecast_settings WHERE enabled = true',
    );
    return result.rows.map((row: any) => this.mapMetricForecastRow(row));
  }

  private mapCacheProposalRow(row: CacheProposalRow): StoredCacheProposal {
    return StoredCacheProposalSchema.parse(row);
  }

  private mapCacheProposalAuditRow(row: CacheProposalAuditRow): StoredCacheProposalAudit {
    return StoredCacheProposalAuditSchema.parse(row);
  }

  async createCacheProposal(input: CreateCacheProposalInput): Promise<StoredCacheProposal> {
    if (!this.pool) throw new Error('Database not initialized');
    const proposedAt = input.proposed_at ?? Date.now();
    const expiresAt = input.expires_at ?? proposedAt + PROPOSAL_DEFAULT_EXPIRY_MS;
    const result = await this.pool.query(
      `INSERT INTO cache_proposals (
        id, connection_id, cache_name, cache_type, proposal_type,
        proposal_payload, reasoning, status, proposed_by, proposed_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10)
      RETURNING *`,
      [
        input.id,
        input.connection_id,
        input.cache_name,
        input.cache_type,
        input.proposal_type,
        JSON.stringify(input.proposal_payload),
        input.reasoning ?? null,
        input.proposed_by ?? null,
        proposedAt,
        expiresAt,
      ],
    );
    return this.mapCacheProposalRow(result.rows[0]);
  }

  async getCacheProposal(id: string): Promise<StoredCacheProposal | null> {
    if (!this.pool) throw new Error('Database not initialized');
    const result = await this.pool.query('SELECT * FROM cache_proposals WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return null;
    }
    return this.mapCacheProposalRow(result.rows[0]);
  }

  async listCacheProposals(options: ListCacheProposalsOptions): Promise<StoredCacheProposal[]> {
    if (!this.pool) throw new Error('Database not initialized');
    if (Array.isArray(options.status) && options.status.length === 0) {
      return [];
    }
    const conditions: string[] = ['connection_id = $1'];
    const params: unknown[] = [options.connection_id];
    let idx = 2;

    if (options.status !== undefined) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      const placeholders = statuses.map(() => `$${idx++}`).join(', ');
      conditions.push(`status IN (${placeholders})`);
      params.push(...statuses);
    }
    if (options.cache_name) {
      conditions.push(`cache_name = $${idx++}`);
      params.push(options.cache_name);
    }
    if (options.cache_type) {
      conditions.push(`cache_type = $${idx++}`);
      params.push(options.cache_type);
    }
    if (options.proposal_type) {
      conditions.push(`proposal_type = $${idx++}`);
      params.push(options.proposal_type);
    }

    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const limitIdx = idx;
    const offsetIdx = idx + 1;
    const query = `
      SELECT * FROM cache_proposals
      WHERE ${conditions.join(' AND ')}
      ORDER BY proposed_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;
    params.push(limit, offset);

    const result = await this.pool.query(query, params);
    return result.rows.map((row: CacheProposalRow) => this.mapCacheProposalRow(row));
  }

  async updateCacheProposalStatus(
    input: UpdateProposalStatusInput,
  ): Promise<StoredCacheProposal | null> {
    if (!this.pool) throw new Error('Database not initialized');
    if (input.expected_status !== undefined || input.proposal_payload !== undefined) {
      const existing = await this.getCacheProposal(input.id);
      if (existing === null) {
        return null;
      }
      if (input.expected_status !== undefined) {
        const allowed = Array.isArray(input.expected_status)
          ? input.expected_status
          : [input.expected_status];
        if (allowed.length === 0 || !allowed.includes(existing.status)) {
          return null;
        }
      }
      if (input.proposal_payload !== undefined) {
        const variantSchema = variantPayloadSchemaFor(existing.cache_type, existing.proposal_type);
        variantSchema.parse(input.proposal_payload);
      }
    }
    const sets: string[] = ['status = $2'];
    const params: unknown[] = [input.id, input.status];
    let nextPlaceholder = 3;
    const whereClauses: string[] = ['id = $1'];

    if (input.expected_status !== undefined) {
      const expected = Array.isArray(input.expected_status)
        ? input.expected_status
        : [input.expected_status];
      if (expected.length === 0) {
        return null;
      }
      const placeholders = expected.map(() => `$${nextPlaceholder++}`).join(', ');
      whereClauses.push(`status IN (${placeholders})`);
      params.push(...expected);
    }

    const pushSet = (column: string, value: unknown): void => {
      sets.push(`${column} = $${nextPlaceholder}`);
      params.push(value);
      nextPlaceholder += 1;
    };

    if (input.reviewed_by !== undefined) {
      pushSet('reviewed_by', input.reviewed_by);
    }
    if (input.reviewed_at !== undefined) {
      pushSet('reviewed_at', input.reviewed_at);
    }
    if (input.applied_at !== undefined) {
      pushSet('applied_at', input.applied_at);
    }
    if (input.applied_result !== undefined) {
      pushSet(
        'applied_result',
        input.applied_result === null ? null : JSON.stringify(input.applied_result),
      );
    }
    if (input.proposal_payload !== undefined) {
      pushSet('proposal_payload', JSON.stringify(input.proposal_payload));
    }

    const result = await this.pool.query(
      `UPDATE cache_proposals SET ${sets.join(', ')} WHERE ${whereClauses.join(' AND ')} RETURNING *`,
      params,
    );
    if (result.rows.length === 0) {
      return null;
    }
    return this.mapCacheProposalRow(result.rows[0]);
  }

  async expireCacheProposalsBefore(now: number): Promise<StoredCacheProposal[]> {
    if (!this.pool) throw new Error('Database not initialized');
    const result = await this.pool.query(
      `UPDATE cache_proposals
       SET status = 'expired'
       WHERE status = 'pending' AND expires_at <= $1
       RETURNING *`,
      [now],
    );
    return result.rows.map((row: CacheProposalRow) => this.mapCacheProposalRow(row));
  }

  async appendCacheProposalAudit(
    input: AppendProposalAuditInput,
  ): Promise<StoredCacheProposalAudit> {
    if (!this.pool) throw new Error('Database not initialized');
    const eventAt = input.event_at ?? Date.now();
    const result = await this.pool.query(
      `INSERT INTO cache_proposal_audit (
        id, proposal_id, event_type, event_payload, event_at, actor, actor_source
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [
        input.id,
        input.proposal_id,
        input.event_type,
        input.event_payload == null ? null : JSON.stringify(input.event_payload),
        eventAt,
        input.actor ?? null,
        input.actor_source,
      ],
    );
    return this.mapCacheProposalAuditRow(result.rows[0]);
  }

  async getCacheProposalAudit(proposalId: string): Promise<StoredCacheProposalAudit[]> {
    if (!this.pool) throw new Error('Database not initialized');
    const result = await this.pool.query(
      'SELECT * FROM cache_proposal_audit WHERE proposal_id = $1 ORDER BY event_at ASC',
      [proposalId],
    );
    return result.rows.map((row: CacheProposalAuditRow) => this.mapCacheProposalAuditRow(row));
  }

  private mapMemoryProposalRow(row: MemoryProposalRow): StoredMemoryProposal {
    return StoredMemoryProposalSchema.parse(row);
  }

  private mapMemoryProposalAuditRow(row: MemoryProposalAuditRow): StoredMemoryProposalAudit {
    return StoredMemoryProposalAuditSchema.parse(row);
  }

  async createMemoryProposal(input: CreateMemoryProposalInput): Promise<StoredMemoryProposal> {
    if (!this.pool) throw new Error('Database not initialized');
    const proposedAt = input.proposed_at ?? Date.now();
    const expiresAt = input.expires_at ?? proposedAt + MEMORY_PROPOSAL_DEFAULT_EXPIRY_MS;
    const result = await this.pool.query(
      `INSERT INTO memory_proposals (
        id, connection_id, store_name, proposal_type,
        proposal_payload, reasoning, status, proposed_by, proposed_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9)
      RETURNING *`,
      [
        input.id,
        input.connection_id,
        input.store_name,
        input.proposal_type,
        JSON.stringify(input.proposal_payload),
        input.reasoning ?? null,
        input.proposed_by ?? null,
        proposedAt,
        expiresAt,
      ],
    );
    return this.mapMemoryProposalRow(result.rows[0]);
  }

  async getMemoryProposal(id: string): Promise<StoredMemoryProposal | null> {
    if (!this.pool) throw new Error('Database not initialized');
    const result = await this.pool.query('SELECT * FROM memory_proposals WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return null;
    }
    return this.mapMemoryProposalRow(result.rows[0]);
  }

  async listMemoryProposals(options: ListMemoryProposalsOptions): Promise<StoredMemoryProposal[]> {
    if (!this.pool) throw new Error('Database not initialized');
    if (Array.isArray(options.status) && options.status.length === 0) {
      return [];
    }
    const conditions: string[] = ['connection_id = $1'];
    const params: unknown[] = [options.connection_id];
    let idx = 2;

    if (options.status !== undefined) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      const placeholders = statuses.map(() => `$${idx++}`).join(', ');
      conditions.push(`status IN (${placeholders})`);
      params.push(...statuses);
    }
    if (options.store_name) {
      conditions.push(`store_name = $${idx++}`);
      params.push(options.store_name);
    }

    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const limitIdx = idx;
    const offsetIdx = idx + 1;
    const query = `
      SELECT * FROM memory_proposals
      WHERE ${conditions.join(' AND ')}
      ORDER BY proposed_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;
    params.push(limit, offset);

    const result = await this.pool.query(query, params);
    return result.rows.map((row: MemoryProposalRow) => this.mapMemoryProposalRow(row));
  }

  async updateMemoryProposalStatus(
    input: UpdateMemoryProposalStatusInput,
  ): Promise<StoredMemoryProposal | null> {
    if (!this.pool) throw new Error('Database not initialized');
    if (input.expected_status !== undefined) {
      const existing = await this.getMemoryProposal(input.id);
      if (existing === null) {
        return null;
      }
      const allowed = Array.isArray(input.expected_status)
        ? input.expected_status
        : [input.expected_status];
      if (allowed.length === 0 || !allowed.includes(existing.status)) {
        return null;
      }
    }
    const sets: string[] = ['status = $2'];
    const params: unknown[] = [input.id, input.status];
    let nextPlaceholder = 3;
    const whereClauses: string[] = ['id = $1'];

    if (input.expected_status !== undefined) {
      const expected = Array.isArray(input.expected_status)
        ? input.expected_status
        : [input.expected_status];
      if (expected.length === 0) {
        return null;
      }
      const placeholders = expected.map(() => `$${nextPlaceholder++}`).join(', ');
      whereClauses.push(`status IN (${placeholders})`);
      params.push(...expected);
    }

    const pushSet = (column: string, value: unknown): void => {
      sets.push(`${column} = $${nextPlaceholder}`);
      params.push(value);
      nextPlaceholder += 1;
    };

    if (input.reviewed_by !== undefined) {
      pushSet('reviewed_by', input.reviewed_by);
    }
    if (input.reviewed_at !== undefined) {
      pushSet('reviewed_at', input.reviewed_at);
    }
    if (input.applied_at !== undefined) {
      pushSet('applied_at', input.applied_at);
    }
    if (input.applied_result !== undefined) {
      pushSet(
        'applied_result',
        input.applied_result === null ? null : JSON.stringify(input.applied_result),
      );
    }
    if (input.proposal_payload !== undefined) {
      pushSet('proposal_payload', JSON.stringify(input.proposal_payload));
    }

    const result = await this.pool.query(
      `UPDATE memory_proposals SET ${sets.join(', ')} WHERE ${whereClauses.join(' AND ')} RETURNING *`,
      params,
    );
    if (result.rows.length === 0) {
      return null;
    }
    return this.mapMemoryProposalRow(result.rows[0]);
  }

  async appendMemoryProposalAudit(
    input: AppendMemoryProposalAuditInput,
  ): Promise<StoredMemoryProposalAudit> {
    if (!this.pool) throw new Error('Database not initialized');
    const eventAt = input.event_at ?? Date.now();
    const result = await this.pool.query(
      `INSERT INTO memory_proposal_audit (
        id, proposal_id, event_type, event_payload, event_at, actor, actor_source
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [
        input.id,
        input.proposal_id,
        input.event_type,
        input.event_payload == null ? null : JSON.stringify(input.event_payload),
        eventAt,
        input.actor ?? null,
        input.actor_source,
      ],
    );
    return this.mapMemoryProposalAuditRow(result.rows[0]);
  }

  async getMemoryProposalAudit(proposalId: string): Promise<StoredMemoryProposalAudit[]> {
    if (!this.pool) throw new Error('Database not initialized');
    const result = await this.pool.query(
      'SELECT * FROM memory_proposal_audit WHERE proposal_id = $1 ORDER BY event_at ASC',
      [proposalId],
    );
    return result.rows.map((row: MemoryProposalAuditRow) => this.mapMemoryProposalAuditRow(row));
  }

  async expireMemoryProposalsBefore(now: number): Promise<StoredMemoryProposal[]> {
    if (!this.pool) throw new Error('Database not initialized');
    const result = await this.pool.query(
      `UPDATE memory_proposals
       SET status = 'expired'
       WHERE status = 'pending' AND expires_at <= $1
       RETURNING *`,
      [now],
    );
    return result.rows.map((row: MemoryProposalRow) => this.mapMemoryProposalRow(row));
  }

  async saveCaptureSession(
    session: StoredCaptureSession,
    connectionId: string,
  ): Promise<string> {
    if (!this.pool) throw new Error('Database not initialized');

    await this.pool.query(
      `INSERT INTO capture_sessions (
        id, connection_id, status, source, trigger_id, schedule_id, requested_by,
        started_at, ended_at, duration_ms, byte_count, line_count, byte_cap, line_cap,
        termination_reason, target_node, node_segments
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        session.id,
        connectionId,
        session.status,
        session.source,
        session.triggerId ?? null,
        session.scheduleId ?? null,
        session.requestedBy ?? null,
        session.startedAt,
        session.endedAt ?? null,
        session.durationMs ?? null,
        session.byteCount,
        session.lineCount,
        session.byteCap,
        session.lineCap,
        session.terminationReason ?? null,
        session.targetNode ?? null,
        session.nodeSegments ? JSON.stringify(session.nodeSegments) : null,
      ],
    );

    return session.id;
  }

  async getCaptureSession(id: string): Promise<StoredCaptureSession | null> {
    if (!this.pool) throw new Error('Database not initialized');

    const result = await this.pool.query(
      'SELECT * FROM capture_sessions WHERE id = $1',
      [id],
    );

    return result.rows.length > 0 ? this.mapCaptureSessionRow(result.rows[0]) : null;
  }

  async getCaptureSessions(
    options: CaptureSessionQueryOptions = {},
  ): Promise<StoredCaptureSession[]> {
    if (!this.pool) throw new Error('Database not initialized');

    const where: string[] = [];
    const params: unknown[] = [];
    let p = 1;

    if (options.connectionId) {
      where.push(`connection_id = $${p++}`);
      params.push(options.connectionId);
    }
    if (options.status) {
      where.push(`status = $${p++}`);
      params.push(options.status);
    }
    if (options.source) {
      where.push(`source = $${p++}`);
      params.push(options.source);
    }
    if (options.startedAfter !== undefined) {
      where.push(`started_at >= $${p++}`);
      params.push(options.startedAfter);
    }
    if (options.startedBefore !== undefined) {
      where.push(`started_at <= $${p++}`);
      params.push(options.startedBefore);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const result = await this.pool.query(
      `SELECT * FROM capture_sessions ${whereClause} ORDER BY started_at DESC LIMIT $${p} OFFSET $${p + 1}`,
      [...params, limit, offset],
    );

    return result.rows.map((row) => this.mapCaptureSessionRow(row));
  }

  private mapCaptureSessionRow(row: Record<string, unknown>): StoredCaptureSession {
    const toNumber = (v: unknown): number => (typeof v === 'string' ? parseInt(v, 10) : (v as number));
    const toOptionalNumber = (v: unknown): number | undefined => {
      if (v === null || v === undefined) return undefined;
      return toNumber(v);
    };
    return {
      id: row.id as string,
      connectionId: row.connection_id as string,
      status: row.status as StoredCaptureSession['status'],
      source: row.source as StoredCaptureSession['source'],
      triggerId: (row.trigger_id as string | null) ?? undefined,
      scheduleId: (row.schedule_id as string | null) ?? undefined,
      requestedBy: (row.requested_by as string | null) ?? undefined,
      startedAt: toNumber(row.started_at),
      endedAt: toOptionalNumber(row.ended_at),
      durationMs: toOptionalNumber(row.duration_ms),
      byteCount: toNumber(row.byte_count),
      lineCount: toNumber(row.line_count),
      byteCap: toNumber(row.byte_cap),
      lineCap: toNumber(row.line_cap),
      terminationReason: (row.termination_reason as string | null) ?? undefined,
      targetNode: (row.target_node as string | null) ?? undefined,
      nodeSegments: normaliseNodeSegments(row.node_segments),
    };
  }

  async updateCaptureSession(id: string, patch: CaptureSessionPatch): Promise<boolean> {
    if (!this.pool) throw new Error('Database not initialized');

    const sets: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    if (patch.status !== undefined) {
      sets.push(`status = $${p++}`);
      params.push(patch.status);
    }
    if (patch.endedAt !== undefined) {
      sets.push(`ended_at = $${p++}`);
      params.push(patch.endedAt);
    }
    if (patch.durationMs !== undefined) {
      sets.push(`duration_ms = $${p++}`);
      params.push(patch.durationMs);
    }
    if (patch.byteCount !== undefined) {
      sets.push(`byte_count = $${p++}`);
      params.push(patch.byteCount);
    }
    if (patch.lineCount !== undefined) {
      sets.push(`line_count = $${p++}`);
      params.push(patch.lineCount);
    }
    if (patch.terminationReason !== undefined) {
      sets.push(`termination_reason = $${p++}`);
      params.push(patch.terminationReason);
    }
    if (patch.nodeSegments !== undefined) {
      sets.push(`node_segments = $${p++}`);
      params.push(JSON.stringify(patch.nodeSegments));
    }

    if (sets.length === 0) return false;

    params.push(id);
    const result = await this.pool.query(
      `UPDATE capture_sessions SET ${sets.join(', ')} WHERE id = $${p}`,
      params,
    );
    return (result.rowCount ?? 0) > 0;
  }

  async saveCaptureChunk(chunk: StoredCaptureChunk): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    const result = await this.pool.query(
      `INSERT INTO capture_chunks (session_id, chunk_index, bytes, line_count, first_ts, last_ts, node_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        chunk.sessionId,
        chunk.chunkIndex,
        chunk.bytes,
        chunk.lineCount,
        chunk.firstTs,
        chunk.lastTs,
        chunk.nodeId ?? null,
      ],
    );
    return result.rowCount ?? 0;
  }

  async saveCaptureTrigger(trigger: StoredCaptureTrigger): Promise<string> {
    if (!this.pool) throw new Error('Database not initialized');
    await this.pool.query(
      `INSERT INTO capture_triggers
         (id, connection_id, metric_type, anomaly_type, expires_at, created_at, created_by,
          status, fired_at, fired_session_id, skip_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        trigger.id,
        trigger.connectionId,
        trigger.metricType,
        trigger.anomalyType,
        trigger.expiresAt,
        trigger.createdAt,
        trigger.createdBy ?? null,
        trigger.status,
        trigger.firedAt ?? null,
        trigger.firedSessionId ?? null,
        trigger.skipReason ?? null,
      ],
    );
    return trigger.id;
  }

  async updateCaptureTrigger(id: string, patch: CaptureTriggerPatch): Promise<boolean> {
    if (!this.pool) throw new Error('Database not initialized');
    const sets: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    if (patch.status !== undefined) {
      sets.push(`status = $${p++}`);
      params.push(patch.status);
    }
    if (patch.firedAt !== undefined) {
      sets.push(`fired_at = $${p++}`);
      params.push(patch.firedAt);
    }
    if (patch.firedSessionId !== undefined) {
      sets.push(`fired_session_id = $${p++}`);
      params.push(patch.firedSessionId);
    }
    if (patch.skipReason !== undefined) {
      sets.push(`skip_reason = $${p++}`);
      params.push(patch.skipReason);
    }
    if (sets.length === 0) return false;
    params.push(id);
    const result = await this.pool.query(
      `UPDATE capture_triggers SET ${sets.join(', ')} WHERE id = $${p}`,
      params,
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getCaptureTrigger(id: string): Promise<StoredCaptureTrigger | null> {
    if (!this.pool) throw new Error('Database not initialized');
    const result = await this.pool.query('SELECT * FROM capture_triggers WHERE id = $1', [id]);
    return result.rows.length > 0 ? this.mapCaptureTriggerRow(result.rows[0]) : null;
  }

  async getCaptureTriggers(
    options: CaptureTriggerQueryOptions = {},
  ): Promise<StoredCaptureTrigger[]> {
    if (!this.pool) throw new Error('Database not initialized');
    const where: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    if (options.connectionId) {
      where.push(`connection_id = $${p++}`);
      params.push(options.connectionId);
    }
    if (options.status) {
      where.push(`status = $${p++}`);
      params.push(options.status);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const result = await this.pool.query(
      `SELECT * FROM capture_triggers ${whereClause} ORDER BY created_at DESC LIMIT $${p} OFFSET $${p + 1}`,
      [...params, limit, offset],
    );
    return result.rows.map((row) => this.mapCaptureTriggerRow(row));
  }

  private mapCaptureTriggerRow(row: Record<string, unknown>): StoredCaptureTrigger {
    const toNumber = (v: unknown): number =>
      typeof v === 'string' ? parseInt(v, 10) : (v as number);
    const toOptionalNumber = (v: unknown): number | undefined => {
      if (v === null || v === undefined) return undefined;
      return toNumber(v);
    };
    return {
      id: row.id as string,
      connectionId: row.connection_id as string,
      metricType: row.metric_type as string,
      anomalyType: row.anomaly_type as string,
      expiresAt: toNumber(row.expires_at),
      createdAt: toNumber(row.created_at),
      createdBy: (row.created_by as string | null) ?? undefined,
      status: row.status as StoredCaptureTrigger['status'],
      firedAt: toOptionalNumber(row.fired_at),
      firedSessionId: (row.fired_session_id as string | null) ?? undefined,
      skipReason: (row.skip_reason as string | null) ?? undefined,
    };
  }

  async saveScheduledCapture(schedule: StoredScheduledCapture): Promise<string> {
    if (!this.pool) throw new Error('Database not initialized');
    await this.pool.query(
      `INSERT INTO scheduled_captures
         (id, connection_id, interval_seconds, cron_expression, duration_ms, status,
          created_at, created_by, last_fired_at, last_fired_session_id, last_skip_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        schedule.id,
        schedule.connectionId,
        schedule.intervalSeconds ?? null,
        schedule.cronExpression ?? null,
        schedule.durationMs,
        schedule.status,
        schedule.createdAt,
        schedule.createdBy ?? null,
        schedule.lastFiredAt ?? null,
        schedule.lastFiredSessionId ?? null,
        schedule.lastSkipReason ?? null,
      ],
    );
    return schedule.id;
  }

  async updateScheduledCapture(id: string, patch: ScheduledCapturePatch): Promise<boolean> {
    if (!this.pool) throw new Error('Database not initialized');
    const sets: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    if (patch.status !== undefined) {
      sets.push(`status = $${p++}`);
      params.push(patch.status);
    }
    if (patch.intervalSeconds !== undefined) {
      sets.push(`interval_seconds = $${p++}`);
      params.push(patch.intervalSeconds);
    }
    if (patch.cronExpression !== undefined) {
      sets.push(`cron_expression = $${p++}`);
      params.push(patch.cronExpression);
    }
    if (patch.durationMs !== undefined) {
      sets.push(`duration_ms = $${p++}`);
      params.push(patch.durationMs);
    }
    if (patch.lastFiredAt !== undefined) {
      sets.push(`last_fired_at = $${p++}`);
      params.push(patch.lastFiredAt);
    }
    if (patch.lastFiredSessionId !== undefined) {
      sets.push(`last_fired_session_id = $${p++}`);
      params.push(patch.lastFiredSessionId);
    }
    if (patch.lastSkipReason !== undefined) {
      sets.push(`last_skip_reason = $${p++}`);
      params.push(patch.lastSkipReason);
    }
    if (sets.length === 0) {
      return false;
    }
    params.push(id);
    const result = await this.pool.query(
      `UPDATE scheduled_captures SET ${sets.join(', ')} WHERE id = $${p}`,
      params,
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deleteScheduledCapture(id: string): Promise<boolean> {
    if (!this.pool) throw new Error('Database not initialized');
    const result = await this.pool.query('DELETE FROM scheduled_captures WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async getScheduledCapture(id: string): Promise<StoredScheduledCapture | null> {
    if (!this.pool) throw new Error('Database not initialized');
    const result = await this.pool.query('SELECT * FROM scheduled_captures WHERE id = $1', [id]);
    return result.rows.length > 0 ? this.mapScheduledCaptureRow(result.rows[0]) : null;
  }

  async getScheduledCaptures(
    options: ScheduledCaptureQueryOptions = {},
  ): Promise<StoredScheduledCapture[]> {
    if (!this.pool) throw new Error('Database not initialized');
    const where: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    if (options.connectionId) {
      where.push(`connection_id = $${p++}`);
      params.push(options.connectionId);
    }
    if (options.status) {
      where.push(`status = $${p++}`);
      params.push(options.status);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const result = await this.pool.query(
      `SELECT * FROM scheduled_captures ${whereClause} ORDER BY created_at DESC LIMIT $${p} OFFSET $${p + 1}`,
      [...params, limit, offset],
    );
    return result.rows.map((row) => this.mapScheduledCaptureRow(row));
  }

  async pruneOldCaptureSessions(cutoffTimestamp: number): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');
    const result = await this.pool.query(
      "DELETE FROM capture_sessions WHERE ended_at IS NOT NULL AND ended_at < $1 AND status != 'running'",
      [cutoffTimestamp],
    );
    return result.rowCount ?? 0;
  }

  async pruneOldCaptureChunks(cutoffTimestamp: number): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');
    const result = await this.pool.query(
      'DELETE FROM capture_chunks WHERE last_ts < $1',
      [cutoffTimestamp],
    );
    return result.rowCount ?? 0;
  }

  async pruneOldCaptureTriggers(cutoffTimestamp: number): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');
    const result = await this.pool.query(
      `DELETE FROM capture_triggers
       WHERE created_at < $1
         AND status IN ('fired','skipped','expired','cancelled')`,
      [cutoffTimestamp],
    );
    return result.rowCount ?? 0;
  }

  async pruneOldScheduledCaptures(cutoffTimestamp: number): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');
    const result = await this.pool.query(
      "DELETE FROM scheduled_captures WHERE created_at < $1 AND status = 'disabled'",
      [cutoffTimestamp],
    );
    return result.rowCount ?? 0;
  }

  private mapScheduledCaptureRow(row: Record<string, unknown>): StoredScheduledCapture {
    const toNumber = (v: unknown): number =>
      typeof v === 'string' ? parseInt(v, 10) : (v as number);
    const toOptionalNumber = (v: unknown): number | undefined => {
      if (v === null || v === undefined) return undefined;
      return toNumber(v);
    };
    return {
      id: row.id as string,
      connectionId: row.connection_id as string,
      intervalSeconds: toOptionalNumber(row.interval_seconds),
      cronExpression: (row.cron_expression as string | null) ?? undefined,
      durationMs: toNumber(row.duration_ms),
      status: row.status as StoredScheduledCapture['status'],
      createdAt: toNumber(row.created_at),
      createdBy: (row.created_by as string | null) ?? undefined,
      lastFiredAt: toOptionalNumber(row.last_fired_at),
      lastFiredSessionId: (row.last_fired_session_id as string | null) ?? undefined,
      lastSkipReason: (row.last_skip_reason as string | null) ?? undefined,
    };
  }

  async getCaptureChunks(sessionId: string): Promise<StoredCaptureChunk[]> {
    if (!this.pool) throw new Error('Database not initialized');

    const result = await this.pool.query(
      'SELECT session_id, chunk_index, bytes, line_count, first_ts, last_ts, node_id FROM capture_chunks WHERE session_id = $1 ORDER BY chunk_index ASC',
      [sessionId],
    );

    const toNumber = (v: unknown): number => (typeof v === 'string' ? parseInt(v, 10) : (v as number));

    return result.rows.map((row) => ({
      sessionId: row.session_id as string,
      chunkIndex: toNumber(row.chunk_index),
      bytes: Buffer.isBuffer(row.bytes) ? (row.bytes as Buffer) : Buffer.from(row.bytes),
      lineCount: toNumber(row.line_count),
      firstTs: toNumber(row.first_ts),
      lastTs: toNumber(row.last_ts),
      nodeId: (row.node_id as string | null) ?? undefined,
    }));
  }
}

function normaliseNodeSegments(raw: unknown): StoredCaptureSession['nodeSegments'] | undefined {
  if (raw === null || raw === undefined) return undefined;
  // pg returns JSONB as already-parsed JS values
  if (Array.isArray(raw)) return raw as StoredCaptureSession['nodeSegments'];
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
