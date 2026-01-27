#!/usr/bin/env ts-node
/**
 * Demo Data Seed Script
 * Generates realistic dummy data for all BetterDB Monitor features
 *
 * Usage: npx ts-node scripts/seed-demo-data.ts
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';

// Configuration
const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'betterdb.sqlite');
const SOURCE_HOST = '127.0.0.1';
const SOURCE_PORT = 6379;

// Time configuration - generate data for the last 7 days
const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const SEVEN_DAYS_AGO = NOW - 7 * DAY_MS;

// Ensure directory exists
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

console.log(`Opening database at: ${DB_PATH}`);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// Create schema if not exists
function createSchema(): void {
  db.exec(`
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
  `);
}

createSchema();

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomSubset<T>(arr: T[], min: number, max: number): T[] {
  const count = randomInt(min, max);
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function generateIP(): string {
  const subnets = ['192.168.1', '192.168.2', '10.0.0', '10.0.1', '172.16.0'];
  return `${randomChoice(subnets)}.${randomInt(1, 254)}`;
}

// ============================================================================
// DATA DEFINITIONS
// ============================================================================

const USERNAMES = ['default', 'admin', 'app-user', 'readonly-user', 'service-account', 'guest', 'monitoring'];
const CLIENT_NAMES = [
  'app-server-1', 'app-server-2', 'app-server-3',
  'web-frontend-1', 'web-frontend-2',
  'cache-layer', 'worker-pool-1', 'worker-pool-2',
  'monitoring-agent', 'backup-service', 'analytics-worker',
  'session-manager', 'rate-limiter', 'pubsub-handler'
];
const COMMANDS = ['GET', 'SET', 'HGET', 'HSET', 'LPUSH', 'RPOP', 'ZADD', 'ZRANGE', 'SCAN', 'DEL', 'EXPIRE', 'TTL', 'MGET', 'MSET', 'INCR'];
const ACL_REASONS = ['auth', 'command', 'key', 'channel'];
const FORBIDDEN_COMMANDS = ['FLUSHALL', 'FLUSHDB', 'CONFIG', 'DEBUG', 'SHUTDOWN', 'SLAVEOF', 'REPLICAOF', 'CLIENT KILL'];
const FORBIDDEN_KEYS = ['admin:*', 'system:*', 'config:*', 'secret:*', '_internal:*'];
const KEY_PATTERNS = ['user:*', 'session:*', 'cache:*', 'queue:*', 'leaderboard:*', 'counter:*', 'rate:*', 'temp:*'];
const METRIC_TYPES = ['memory', 'connections', 'latency', 'slowlog', 'cpu', 'network', 'commands_per_sec'];
const ANOMALY_TYPES = ['spike', 'dip', 'trend', 'outlier'];
const SEVERITIES = ['warning', 'critical'];
const CORRELATION_PATTERNS = ['memory_pressure', 'connection_storm', 'slow_queries', 'resource_exhaustion'];

const WEBHOOK_EVENTS = [
  'instance.down', 'instance.up', 'memory.critical', 'connection.critical',
  'anomaly.detected', 'slowlog.threshold', 'latency.spike', 'connection.spike',
  'client.blocked', 'acl.violation', 'acl.modified', 'config.changed',
  'replication.lag', 'cluster.failover', 'audit.policy.violation', 'compliance.alert'
];

// ============================================================================
// SEED FUNCTIONS
// ============================================================================

function seedAclAudit(): void {
  console.log('Seeding ACL Audit entries...');

  const insert = db.prepare(`
    INSERT INTO acl_audit (
      count, reason, context, object, username, age_seconds,
      client_info, timestamp_created, timestamp_last_updated,
      captured_at, source_host, source_port
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const entries: any[] = [];
  let entryId = 0;

  // Generate 150 ACL audit entries spread over 7 days
  for (let i = 0; i < 150; i++) {
    const timestamp = SEVEN_DAYS_AGO + randomInt(0, 7 * DAY_MS);
    const reason = randomChoice(ACL_REASONS);
    const username = randomChoice(USERNAMES);
    const clientIP = generateIP();
    const clientPort = randomInt(40000, 65000);

    let object: string;
    let context: string;

    switch (reason) {
      case 'auth':
        object = 'AUTH';
        context = 'toplevel';
        break;
      case 'command':
        object = randomChoice(FORBIDDEN_COMMANDS);
        context = 'toplevel';
        break;
      case 'key':
        object = randomChoice(FORBIDDEN_KEYS).replace('*', randomInt(1, 1000).toString());
        context = randomChoice(['GET', 'SET', 'DEL', 'HGET', 'HSET']);
        break;
      case 'channel':
        object = `__keyspace@0__:${randomChoice(KEY_PATTERNS).replace('*', '')}${randomInt(1, 100)}`;
        context = 'SUBSCRIBE';
        break;
      default:
        object = 'UNKNOWN';
        context = 'toplevel';
    }

    entries.push({
      count: randomInt(1, 10),
      reason,
      context,
      object,
      username,
      ageSeconds: randomInt(0, 3600),
      clientInfo: `id=${entryId++} addr=${clientIP}:${clientPort} fd=8 name=${randomChoice(CLIENT_NAMES)} age=${randomInt(100, 10000)} idle=${randomInt(0, 100)} flags=N db=0 sub=0 psub=0 multi=-1 qbuf=0 qbuf-free=0 obl=0 oll=0 omem=0 events=r cmd=${randomChoice(COMMANDS)}`,
      timestampCreated: timestamp,
      timestampLastUpdated: timestamp + randomInt(0, HOUR_MS),
      capturedAt: timestamp + randomInt(0, MINUTE_MS * 5),
      sourceHost: SOURCE_HOST,
      sourcePort: SOURCE_PORT,
    });
  }

  const insertMany = db.transaction((entries: any[]) => {
    for (const entry of entries) {
      insert.run(
        entry.count, entry.reason, entry.context, entry.object, entry.username,
        entry.ageSeconds, entry.clientInfo, entry.timestampCreated,
        entry.timestampLastUpdated, entry.capturedAt, entry.sourceHost, entry.sourcePort
      );
    }
  });

  insertMany(entries);
  console.log(`  Created ${entries.length} ACL audit entries`);
}

function seedClientSnapshots(): void {
  console.log('Seeding Client Snapshots...');

  const insert = db.prepare(`
    INSERT INTO client_snapshots (
      client_id, addr, name, user, db, cmd, age, idle, flags,
      sub, psub, qbuf, qbuf_free, obl, oll, omem,
      captured_at, source_host, source_port
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const snapshots: any[] = [];

  // Generate hourly snapshots for 7 days (168 hours)
  // Each snapshot has 10-30 clients
  for (let hour = 0; hour < 168; hour++) {
    const timestamp = SEVEN_DAYS_AGO + hour * HOUR_MS;
    const isBusinessHours = (hour % 24) >= 8 && (hour % 24) <= 20;
    const clientCount = isBusinessHours ? randomInt(15, 30) : randomInt(5, 15);

    // Select which clients are connected this hour
    const activeClients = randomSubset(CLIENT_NAMES, clientCount, clientCount);

    for (const clientName of activeClients) {
      const clientIP = generateIP();
      const clientPort = randomInt(40000, 65000);
      const user = randomChoice(USERNAMES.slice(0, 4)); // Mainly app users

      // Simulate some clients having high buffers occasionally
      const hasHighBuffer = Math.random() < 0.05;
      const hasHighOmem = Math.random() < 0.03;

      snapshots.push({
        clientId: `${randomInt(100, 999)}`,
        addr: `${clientIP}:${clientPort}`,
        name: clientName,
        user,
        db: 0,
        cmd: randomChoice(COMMANDS),
        age: randomInt(60, 86400), // 1 min to 24 hours
        idle: isBusinessHours ? randomInt(0, 30) : randomInt(30, 600),
        flags: 'N',
        sub: clientName.includes('pubsub') ? randomInt(1, 10) : 0,
        psub: clientName.includes('pubsub') ? randomInt(0, 5) : 0,
        qbuf: hasHighBuffer ? randomInt(1000000, 5000000) : randomInt(0, 50000),
        qbufFree: randomInt(10000, 50000),
        obl: randomInt(0, 100),
        oll: randomInt(0, 50),
        omem: hasHighOmem ? randomInt(10000000, 50000000) : randomInt(0, 1000000),
        capturedAt: timestamp,
        sourceHost: SOURCE_HOST,
        sourcePort: SOURCE_PORT,
      });
    }
  }

  const insertMany = db.transaction((snapshots: any[]) => {
    for (const snapshot of snapshots) {
      insert.run(
        snapshot.clientId, snapshot.addr, snapshot.name, snapshot.user,
        snapshot.db, snapshot.cmd, snapshot.age, snapshot.idle, snapshot.flags,
        snapshot.sub, snapshot.psub, snapshot.qbuf, snapshot.qbufFree,
        snapshot.obl, snapshot.oll, snapshot.omem, snapshot.capturedAt,
        snapshot.sourceHost, snapshot.sourcePort
      );
    }
  });

  insertMany(snapshots);
  console.log(`  Created ${snapshots.length} client snapshots`);
}

function seedAnomalyEvents(): void {
  console.log('Seeding Anomaly Events...');

  const insertEvent = db.prepare(`
    INSERT INTO anomaly_events (
      id, timestamp, metric_type, anomaly_type, severity,
      value, baseline, std_dev, z_score, threshold,
      message, correlation_id, related_metrics,
      resolved, resolved_at, duration_ms, source_host, source_port
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertGroup = db.prepare(`
    INSERT INTO correlated_anomaly_groups (
      correlation_id, timestamp, pattern, severity,
      diagnosis, recommendations, anomaly_count, metric_types,
      source_host, source_port
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const events: any[] = [];
  const groups: any[] = [];

  // Generate 80 anomaly events
  for (let i = 0; i < 80; i++) {
    const timestamp = SEVEN_DAYS_AGO + randomInt(0, 7 * DAY_MS);
    const metricType = randomChoice(METRIC_TYPES);
    const anomalyType = randomChoice(ANOMALY_TYPES);
    const severity = Math.random() < 0.3 ? 'critical' : 'warning';
    const baseline = randomFloat(50, 200);
    const stdDev = randomFloat(10, 50);
    const zScore = severity === 'critical' ? randomFloat(3, 5) : randomFloat(2, 3);
    const value = baseline + zScore * stdDev;
    const resolved = Math.random() < 0.7;

    // Group some anomalies together
    let correlationId: string | null = null;
    if (Math.random() < 0.4) {
      correlationId = randomUUID();
    }

    events.push({
      id: randomUUID(),
      timestamp,
      metricType,
      anomalyType,
      severity,
      value,
      baseline,
      stdDev,
      zScore,
      threshold: 2.5,
      message: `${severity.toUpperCase()}: ${metricType} ${anomalyType} detected. Value ${value.toFixed(2)} exceeds baseline ${baseline.toFixed(2)} by ${zScore.toFixed(2)} standard deviations.`,
      correlationId,
      relatedMetrics: correlationId ? JSON.stringify(randomSubset(METRIC_TYPES, 1, 3)) : null,
      resolved: resolved ? 1 : 0,
      resolvedAt: resolved ? timestamp + randomInt(MINUTE_MS * 5, HOUR_MS * 2) : null,
      durationMs: resolved ? randomInt(MINUTE_MS * 5, HOUR_MS * 2) : null,
      sourceHost: SOURCE_HOST,
      sourcePort: SOURCE_PORT,
    });

    // Create correlated group if this is a correlation leader
    if (correlationId && Math.random() < 0.5) {
      const pattern = randomChoice(CORRELATION_PATTERNS);
      const recommendations = [
        'Monitor memory usage closely',
        'Consider scaling horizontally',
        'Review slow queries',
        'Check client connection patterns',
        'Analyze command distribution'
      ];

      groups.push({
        correlationId,
        timestamp,
        pattern,
        severity,
        diagnosis: `Detected ${pattern.replace('_', ' ')} pattern affecting multiple metrics`,
        recommendations: JSON.stringify(randomSubset(recommendations, 2, 4)),
        anomalyCount: randomInt(2, 5),
        metricTypes: JSON.stringify(randomSubset(METRIC_TYPES, 2, 4)),
        sourceHost: SOURCE_HOST,
        sourcePort: SOURCE_PORT,
      });
    }
  }

  const insertEvents = db.transaction((events: any[]) => {
    for (const event of events) {
      insertEvent.run(
        event.id, event.timestamp, event.metricType, event.anomalyType, event.severity,
        event.value, event.baseline, event.stdDev, event.zScore, event.threshold,
        event.message, event.correlationId, event.relatedMetrics,
        event.resolved, event.resolvedAt, event.durationMs, event.sourceHost, event.sourcePort
      );
    }
  });

  const insertGroups = db.transaction((groups: any[]) => {
    for (const group of groups) {
      insertGroup.run(
        group.correlationId, group.timestamp, group.pattern, group.severity,
        group.diagnosis, group.recommendations, group.anomalyCount, group.metricTypes,
        group.sourceHost, group.sourcePort
      );
    }
  });

  insertEvents(events);
  insertGroups(groups);
  console.log(`  Created ${events.length} anomaly events and ${groups.length} correlated groups`);
}

function seedKeyPatternSnapshots(): void {
  console.log('Seeding Key Pattern Snapshots...');

  const insert = db.prepare(`
    INSERT INTO key_pattern_snapshots (
      id, timestamp, pattern, key_count, sampled_key_count,
      keys_with_ttl, keys_expiring_soon, total_memory_bytes,
      avg_memory_bytes, max_memory_bytes, avg_access_frequency,
      hot_key_count, cold_key_count, avg_idle_time_seconds,
      stale_key_count, avg_ttl_seconds, min_ttl_seconds, max_ttl_seconds
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const snapshots: any[] = [];

  // Generate daily snapshots for each pattern over 7 days
  for (let day = 0; day < 7; day++) {
    const timestamp = SEVEN_DAYS_AGO + day * DAY_MS + randomInt(0, HOUR_MS * 2);

    for (const pattern of KEY_PATTERNS) {
      // Simulate growth over time
      const growthFactor = 1 + (day * 0.05);
      const baseKeyCount = pattern.includes('session') ? 50000 :
                          pattern.includes('cache') ? 100000 :
                          pattern.includes('user') ? 25000 : 10000;

      const keyCount = Math.floor(baseKeyCount * growthFactor * randomFloat(0.9, 1.1));
      const sampledKeyCount = Math.min(keyCount, 1000);
      const keysWithTtl = Math.floor(keyCount * randomFloat(0.3, 0.9));
      const keysExpiringSoon = Math.floor(keysWithTtl * randomFloat(0.05, 0.15));
      const avgMemoryBytes = pattern.includes('session') ? randomInt(500, 2000) :
                             pattern.includes('cache') ? randomInt(1000, 10000) :
                             randomInt(100, 1000);
      const totalMemoryBytes = keyCount * avgMemoryBytes;
      const maxMemoryBytes = avgMemoryBytes * randomInt(5, 20);
      const hotKeyCount = Math.floor(keyCount * randomFloat(0.05, 0.15));
      const coldKeyCount = Math.floor(keyCount * randomFloat(0.1, 0.3));
      const staleKeyCount = Math.floor(keyCount * randomFloat(0.01, 0.08));

      snapshots.push({
        id: randomUUID(),
        timestamp,
        pattern,
        keyCount,
        sampledKeyCount,
        keysWithTtl,
        keysExpiringSoon,
        totalMemoryBytes,
        avgMemoryBytes,
        maxMemoryBytes,
        avgAccessFrequency: randomFloat(0.1, 10),
        hotKeyCount,
        coldKeyCount,
        avgIdleTimeSeconds: randomFloat(60, 3600),
        staleKeyCount,
        avgTtlSeconds: randomInt(3600, 86400),
        minTtlSeconds: randomInt(60, 3600),
        maxTtlSeconds: randomInt(86400, 604800),
      });
    }
  }

  const insertMany = db.transaction((snapshots: any[]) => {
    for (const snapshot of snapshots) {
      insert.run(
        snapshot.id, snapshot.timestamp, snapshot.pattern, snapshot.keyCount,
        snapshot.sampledKeyCount, snapshot.keysWithTtl, snapshot.keysExpiringSoon,
        snapshot.totalMemoryBytes, snapshot.avgMemoryBytes, snapshot.maxMemoryBytes,
        snapshot.avgAccessFrequency, snapshot.hotKeyCount, snapshot.coldKeyCount,
        snapshot.avgIdleTimeSeconds, snapshot.staleKeyCount, snapshot.avgTtlSeconds,
        snapshot.minTtlSeconds, snapshot.maxTtlSeconds
      );
    }
  });

  insertMany(snapshots);
  console.log(`  Created ${snapshots.length} key pattern snapshots`);
}

function seedWebhooks(): void {
  console.log('Seeding Webhooks and Deliveries...');

  const insertWebhook = db.prepare(`
    INSERT INTO webhooks (id, name, url, secret, enabled, events, headers, retry_policy, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertDelivery = db.prepare(`
    INSERT INTO webhook_deliveries (
      id, webhook_id, event_type, payload, status, status_code, response_body,
      attempts, next_retry_at, created_at, completed_at, duration_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const webhooks = [
    {
      id: randomUUID(),
      name: 'Slack Alerts',
      url: 'https://hooks.slack.example.com/services/T00/B00/webhook',
      secret: 'slack-secret-key-123',
      enabled: true,
      events: ['instance.down', 'instance.up', 'memory.critical', 'connection.critical'],
    },
    {
      id: randomUUID(),
      name: 'PagerDuty Integration',
      url: 'https://events.pagerduty.example.com/v2/enqueue',
      secret: 'pd-routing-key-456',
      enabled: true,
      events: ['instance.down', 'memory.critical', 'anomaly.detected', 'latency.spike'],
    },
    {
      id: randomUUID(),
      name: 'Custom Analytics',
      url: 'https://analytics.internal.example.com/webhook/valkey',
      secret: null,
      enabled: true,
      events: ['anomaly.detected', 'slowlog.threshold', 'connection.spike'],
    },
    {
      id: randomUUID(),
      name: 'Security Audit Logger',
      url: 'https://security.example.com/audit/webhook',
      secret: 'audit-secret-789',
      enabled: true,
      events: ['acl.violation', 'acl.modified', 'config.changed', 'audit.policy.violation'],
    },
    {
      id: randomUUID(),
      name: 'Disabled Test Webhook',
      url: 'https://test.example.com/webhook',
      secret: null,
      enabled: false,
      events: ['instance.down', 'instance.up'],
    },
  ];

  const deliveries: any[] = [];
  const statuses = ['success', 'success', 'success', 'success', 'failed', 'retrying', 'dead_letter'];
  const statusCodes = [200, 200, 200, 201, 500, 502, 503, 408];

  // Insert webhooks and generate deliveries
  const now = Date.now();
  const createdAt = SEVEN_DAYS_AGO - DAY_MS; // Webhooks created 8 days ago

  for (const webhook of webhooks) {
    const retryPolicy = {
      maxRetries: 3,
      backoffMultiplier: 2,
      initialDelayMs: 1000,
      maxDelayMs: 60000,
    };

    insertWebhook.run(
      webhook.id,
      webhook.name,
      webhook.url,
      webhook.secret,
      webhook.enabled ? 1 : 0,
      JSON.stringify(webhook.events),
      JSON.stringify({ 'Content-Type': 'application/json' }),
      JSON.stringify(retryPolicy),
      createdAt,
      createdAt
    );

    // Generate 30-60 deliveries per enabled webhook
    if (webhook.enabled) {
      const deliveryCount = randomInt(30, 60);

      for (let i = 0; i < deliveryCount; i++) {
        const eventType = randomChoice(webhook.events);
        const timestamp = SEVEN_DAYS_AGO + randomInt(0, 7 * DAY_MS);
        const status = randomChoice(statuses);
        const statusCode = status === 'success' ? randomChoice([200, 201]) :
                          status === 'failed' || status === 'dead_letter' ? randomChoice([500, 502, 503]) :
                          null;
        const attempts = status === 'success' ? randomInt(1, 2) :
                        status === 'retrying' ? randomInt(1, 3) :
                        status === 'dead_letter' ? 4 :
                        randomInt(1, 4);
        const durationMs = status === 'success' ? randomInt(50, 500) :
                          status === 'retrying' ? null :
                          randomInt(100, 5000);

        const payload = {
          id: randomUUID(),
          event: eventType,
          timestamp,
          instance: { host: SOURCE_HOST, port: SOURCE_PORT },
          data: generateEventData(eventType),
        };

        deliveries.push({
          id: randomUUID(),
          webhookId: webhook.id,
          eventType,
          payload: JSON.stringify(payload),
          status,
          statusCode,
          responseBody: status === 'success' ? '{"ok":true}' :
                       status === 'failed' ? '{"error":"Internal Server Error"}' :
                       null,
          attempts,
          nextRetryAt: status === 'retrying' ? timestamp + randomInt(MINUTE_MS, HOUR_MS) : null,
          createdAt: timestamp,
          completedAt: status === 'success' || status === 'failed' || status === 'dead_letter' ?
                      timestamp + (durationMs || 0) : null,
          durationMs,
        });
      }
    }
  }

  const insertDeliveries = db.transaction((deliveries: any[]) => {
    for (const delivery of deliveries) {
      insertDelivery.run(
        delivery.id, delivery.webhookId, delivery.eventType, delivery.payload,
        delivery.status, delivery.statusCode, delivery.responseBody, delivery.attempts,
        delivery.nextRetryAt, delivery.createdAt, delivery.completedAt, delivery.durationMs
      );
    }
  });

  insertDeliveries(deliveries);
  console.log(`  Created ${webhooks.length} webhooks and ${deliveries.length} deliveries`);
}

function generateEventData(eventType: string): Record<string, any> {
  switch (eventType) {
    case 'instance.down':
    case 'instance.up':
      return {
        previousState: eventType === 'instance.up' ? 'down' : 'up',
        reason: eventType === 'instance.down' ? 'Connection refused' : 'Health check passed',
        downtimeDuration: eventType === 'instance.up' ? randomInt(5000, 300000) : undefined,
      };
    case 'memory.critical':
      return {
        usedMemory: randomInt(8000000000, 15000000000),
        maxMemory: 16000000000,
        usagePercent: randomFloat(85, 98),
        fragmentation: randomFloat(1.0, 2.5),
      };
    case 'connection.critical':
      return {
        currentConnections: randomInt(9000, 10000),
        maxConnections: 10000,
        usagePercent: randomFloat(90, 100),
      };
    case 'anomaly.detected':
      return {
        metricType: randomChoice(METRIC_TYPES),
        anomalyType: randomChoice(ANOMALY_TYPES),
        value: randomFloat(100, 500),
        baseline: randomFloat(50, 150),
        zScore: randomFloat(2.5, 5),
      };
    case 'slowlog.threshold':
      return {
        command: randomChoice(['KEYS *', 'SCAN 0 COUNT 1000000', 'SMEMBERS large_set', 'HGETALL big_hash']),
        duration: randomInt(100000, 5000000),
        threshold: 10000,
      };
    case 'latency.spike':
      return {
        latency: randomFloat(50, 200),
        baseline: randomFloat(5, 20),
        percentile: 'p99',
      };
    case 'connection.spike':
      return {
        connections: randomInt(200, 500),
        baseline: randomInt(50, 100),
        topClients: CLIENT_NAMES.slice(0, 3).map(name => ({ name, count: randomInt(10, 50) })),
      };
    case 'acl.violation':
      return {
        username: randomChoice(USERNAMES),
        reason: randomChoice(ACL_REASONS),
        object: randomChoice(FORBIDDEN_COMMANDS),
        clientAddr: `${generateIP()}:${randomInt(40000, 65000)}`,
      };
    case 'acl.modified':
      return {
        username: randomChoice(USERNAMES),
        action: randomChoice(['added', 'removed', 'modified']),
        permissions: randomChoice(['allcommands', '+@read -@dangerous', '+get +set -flushall']),
      };
    case 'config.changed':
      return {
        parameter: randomChoice(['maxmemory', 'maxclients', 'timeout', 'slowlog-log-slower-than']),
        oldValue: randomChoice(['0', '10000', '128mb', '1gb']),
        newValue: randomChoice(['16gb', '5000', '256mb', '2gb']),
      };
    default:
      return { message: 'Event triggered' };
  }
}

function seedSettings(): void {
  console.log('Seeding App Settings...');

  const insert = db.prepare(`
    INSERT OR REPLACE INTO app_settings (
      id, audit_poll_interval_ms, client_analytics_poll_interval_ms,
      anomaly_poll_interval_ms, anomaly_cache_ttl_ms, anomaly_prometheus_interval_ms,
      updated_at, created_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = Date.now();
  insert.run(60000, 60000, 1000, 3600000, 30000, now, now - DAY_MS);
  console.log('  Created app settings');
}

function clearExistingData(): void {
  console.log('Clearing existing data...');

  db.exec('DELETE FROM webhook_deliveries');
  db.exec('DELETE FROM webhooks');
  db.exec('DELETE FROM acl_audit');
  db.exec('DELETE FROM client_snapshots');
  db.exec('DELETE FROM anomaly_events');
  db.exec('DELETE FROM correlated_anomaly_groups');
  db.exec('DELETE FROM key_pattern_snapshots');
  db.exec('DELETE FROM app_settings');

  console.log('  Cleared all tables');
}

// ============================================================================
// MAIN
// ============================================================================

function main(): void {
  console.log('='.repeat(60));
  console.log('BetterDB Monitor - Demo Data Seeder');
  console.log('='.repeat(60));
  console.log();

  try {
    clearExistingData();
    console.log();

    seedSettings();
    seedAclAudit();
    seedClientSnapshots();
    seedAnomalyEvents();
    seedKeyPatternSnapshots();
    seedWebhooks();

    console.log();
    console.log('='.repeat(60));
    console.log('Demo data seeding complete!');
    console.log('='.repeat(60));
    console.log();
    console.log('Summary:');
    console.log('  - 150 ACL audit entries');
    console.log('  - ~3000 client snapshots (7 days of hourly data)');
    console.log('  - 80 anomaly events with correlated groups');
    console.log('  - 56 key pattern snapshots (8 patterns x 7 days)');
    console.log('  - 5 webhooks with ~200 deliveries');
    console.log('  - App settings configured');
    console.log();
    console.log('You can now start the application and explore the demo data!');
  } catch (error) {
    console.error('Error seeding data:', error);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
