---
title: Configuration
nav_order: 2
---

# Configuration Reference

This document provides comprehensive configuration information for BetterDB Monitor.

## Table of Contents

- [Multi-Connection Support](#multi-connection-support)
- [Environment Variables](#environment-variables)
  - [Data Retention](#data-retention)
- [Docker Usage](#docker-usage)
- [HTTP Endpoints](#http-endpoints)
- [Runtime Settings](#runtime-settings)
- [Container Management](#container-management)

## Multi-Connection Support

BetterDB Monitor supports monitoring multiple Valkey/Redis instances from a single deployment. This enables centralized monitoring of development, staging, and production databases.

### How It Works

1. **Connection Registry**: All database connections are managed through a central registry
2. **Default Connection**: On first startup, a default connection is created from environment variables (`DB_HOST`, `DB_PORT`, etc.)
3. **Connection Scoping**: All data (metrics, audit logs, webhooks, etc.) is isolated per connection using the `X-Connection-Id` header
4. **Prometheus Labels**: All metrics include a `connection` label for filtering (e.g., `betterdb_memory_used_bytes{connection="localhost:6379"}`)

### Managing Connections

#### Via API

```bash
# List all connections
curl http://localhost:3001/connections

# Add a new connection
curl -X POST http://localhost:3001/connections \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Production Redis",
    "host": "prod-redis.example.com",
    "port": 6379,
    "password": "secret"
  }'

# Test a connection before adding
curl -X POST http://localhost:3001/connections/test \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test",
    "host": "staging-redis.example.com",
    "port": 6379
  }'

# Set a connection as default
curl -X POST http://localhost:3001/connections/{id}/default

# Remove a connection
curl -X DELETE http://localhost:3001/connections/{id}
```

#### Via Web UI

Use the connection selector in the top navigation bar to:
- View all registered connections and their status
- Switch between connections (data displayed is scoped to selected connection)
- Add new connections with the "+" button
- Manage connections (set default, reconnect, delete)

### Connection-Scoped Requests

When making API requests, include the `X-Connection-Id` header to target a specific connection:

```bash
# Get metrics for a specific connection
curl -H "X-Connection-Id: prod-conn-id" http://localhost:3001/metrics/info

# Get audit logs for a specific connection
curl -H "X-Connection-Id: staging-conn-id" http://localhost:3001/audit/entries
```

If no header is provided, the default connection is used.

### Webhooks and Connections

Webhooks can be:
- **Global**: Fire for events from any connection (created without `X-Connection-Id`)
- **Connection-scoped**: Fire only for events from a specific connection (created with `X-Connection-Id`)

```bash
# Create a webhook that fires for ALL connections
curl -X POST http://localhost:3001/webhooks \
  -H "Content-Type: application/json" \
  -d '{"name": "Global Alert", "url": "https://...", "events": ["instance.down"]}'

# Create a webhook only for production
curl -X POST http://localhost:3001/webhooks \
  -H "X-Connection-Id: prod-conn-id" \
  -H "Content-Type: application/json" \
  -d '{"name": "Prod Alert", "url": "https://...", "events": ["instance.down"]}'
```

### Data Isolation

All stored data is isolated by connection:
- Audit trail entries
- Client analytics snapshots
- Slowlog/Commandlog entries
- Anomaly events
- Key analytics snapshots

This means:
- Querying `/audit/entries` with `X-Connection-Id: A` returns only data from connection A
- Prometheus metrics are labeled with `connection="host:port"` for filtering
- Dashboard displays data for the currently selected connection

## Environment Variables

### Database Connection

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DB_HOST` | Yes | `localhost` | Valkey/Redis host to monitor |
| `DB_PORT` | No | `6379` | Valkey/Redis port |
| `DB_USERNAME` | No | `default` | Valkey/Redis ACL username |
| `DB_PASSWORD` | No | - | Valkey/Redis password |
| `DB_TYPE` | No | `auto` | Database type: `auto`, `valkey`, or `redis` |

### Storage Backend

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STORAGE_TYPE` | No | `memory` | Storage backend: `memory`, `postgres`, or `sqlite` |
| `STORAGE_URL` | Conditional | - | PostgreSQL connection URL (required if `STORAGE_TYPE=postgres`) |
| `STORAGE_SQLITE_FILEPATH` | No | `./data/audit.db` | SQLite database file path (only for `STORAGE_TYPE=sqlite`) |

**Note**: SQLite is only available for local development. Docker production images do not include SQLite support. Use `postgres` or `memory` for Docker deployments.

### Application Settings

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3001` | Application HTTP port |
| `NODE_ENV` | No | `production` | Node environment (`production` or `development`) |

### Security

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ENCRYPTION_KEY` | No | - | Master key for encrypting stored passwords (min 16 characters) |
| `ENCRYPTION_KEK_SALT` | No | `betterdb-kek-salt-v1` | Salt used for key derivation (customize for additional security) |

**Password Encryption**: When `ENCRYPTION_KEY` is set, all connection passwords are encrypted at rest using envelope encryption (AES-256-GCM). Each password gets a unique encryption key (DEK) that is itself encrypted with a master key (KEK) derived from your `ENCRYPTION_KEY`.

- If not set, passwords are stored in plaintext (a warning is logged at startup)
- Use a strong, random key (e.g., `openssl rand -base64 32`)
- Store the key securely (e.g., in a secrets manager)
- If you lose the key, encrypted passwords cannot be recovered
- Optionally set `ENCRYPTION_KEK_SALT` to a custom value for defense-in-depth (attackers would need both key and salt)

### Audit Trail

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AUDIT_POLL_INTERVAL_MS` | No | `60000` | ACL audit polling interval (milliseconds) |

### Anomaly Detection

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANOMALY_DETECTION_ENABLED` | No | `true` | Enable anomaly detection features (Pro tier required) |
| `ANOMALY_POLL_INTERVAL_MS` | No | `1000` | Anomaly detection polling interval (milliseconds) |
| `ANOMALY_CACHE_TTL_MS` | No | `3600000` | Anomaly detection cache TTL (milliseconds) |
| `ANOMALY_PROMETHEUS_INTERVAL_MS` | No | `30000` | Prometheus summary update interval (milliseconds) |

### Client Analytics

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CLIENT_ANALYTICS_POLL_INTERVAL_MS` | No | `60000` | Client analytics polling interval (milliseconds) |

### Data Retention

Self-hosted BetterDB has **no artificial data retention limits**. Your data retention is determined by:

- Your storage backend capacity (PostgreSQL, SQLite, etc.)
- Any cleanup jobs or policies you configure on your database
- Available disk space

**BetterDB Cloud** (launching Q1 2026) will offer managed retention policies by tier.

### License Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BETTERDB_LICENSE_KEY` | No | - | BetterDB Pro license key for premium features |
| `BETTERDB_TELEMETRY` | No | `true` | Enable anonymous telemetry (set to `false` to disable) |
| `ENTITLEMENT_URL` | No | `https://betterdb.com/api/v1/entitlements` | Entitlement validation endpoint |
| `LICENSE_CACHE_TTL_MS` | No | `3600000` | License cache TTL (milliseconds) |
| `LICENSE_MAX_STALE_MS` | No | `604800000` | Maximum stale license age (milliseconds) |
| `LICENSE_TIMEOUT_MS` | No | `10000` | License validation timeout (milliseconds) |

**Telemetry**: BetterDB Monitor collects anonymous usage telemetry to help improve the product. No personally identifiable information is collected. The telemetry includes:
- Instance ID (deterministic hash derived from DB_HOST, DB_PORT, STORAGE_URL, and license key)
- Application version
- Platform and architecture (e.g., linux, x64)
- Node.js version
- License tier (community/pro/enterprise)

To disable telemetry, set `BETTERDB_TELEMETRY=false` in your environment variables.

### Version Update Checks

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VERSION_CHECK_INTERVAL_MS` | No | `21600000` | Version check interval (milliseconds, default: 6 hours) |

BetterDB Monitor automatically checks for new versions and displays an update banner in the web UI when a newer version is available. Version information is obtained from:

1. **Entitlement server** (piggybacked on license/telemetry requests) - primary source
2. **GitHub Releases API** - fallback when entitlement data is unavailable

### Key Analytics (Pro Tier)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KEY_ANALYTICS_SAMPLE_SIZE` | No | `10000` | Number of keys to sample for analytics |
| `KEY_ANALYTICS_SCAN_BATCH_SIZE` | No | `1000` | Batch size for key scanning operations |
| `KEY_ANALYTICS_INTERVAL_MS` | No | `300000` | Key analytics collection interval (milliseconds) |

**Note**: Key analytics features require a Pro tier license.

### AI Features (Experimental)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AI_ENABLED` | No | `false` | Enable AI-powered features (chatbot, RAG) |
| `OLLAMA_BASE_URL` | No | `http://localhost:11434` | Ollama API endpoint for LLM inference |
| `OLLAMA_KEEP_ALIVE` | No | `24h` | Keep-alive duration for Ollama models |
| `AI_USE_LLM_CLASSIFICATION` | No | `false` | Use LLM for anomaly classification |
| `LANCEDB_PATH` | No | `./data/lancedb` | Path to LanceDB vector database |
| `VALKEY_DOCS_PATH` | No | `./data/valkey-docs` | Path to indexed Valkey documentation |

**Note**: AI features are experimental and require explicit opt-in. You must have Ollama running locally or accessible at the configured URL.

## Docker Usage

### Building the Image

```bash
pnpm docker:build
```

For multi-arch builds (AMD64 + ARM64):

```bash
docker buildx create --name mybuilder --use --bootstrap
pnpm docker:build:multiarch
```

### Running the Container

#### Basic Setup (Memory Storage)

```bash
docker run -d \
  --name betterdb-monitor \
  -p 3001:3001 \
  -e DB_HOST=your-valkey-host \
  -e DB_PORT=6379 \
  -e DB_PASSWORD=your-password \
  -e BETTERDB_LICENSE_KEY=your-license-key \
  -e STORAGE_TYPE=memory \
  betterdb/monitor
```

#### PostgreSQL Storage

```bash
docker run -d \
  --name betterdb-monitor \
  -p 3001:3001 \
  -e DB_HOST=your-valkey-host \
  -e DB_PORT=6379 \
  -e DB_PASSWORD=your-password \
  -e BETTERDB_LICENSE_KEY=your-license-key \
  -e STORAGE_TYPE=postgres \
  -e STORAGE_URL=postgresql://user:pass@postgres-host:5432/dbname \
  betterdb/monitor
```

#### Custom Port

You can run the application on any port by setting the `PORT` environment variable:

```bash
docker run -d \
  --name betterdb-monitor \
  -p 8080:8080 \
  -e PORT=8080 \
  -e DB_HOST=your-valkey-host \
  -e DB_PORT=6379 \
  -e DB_PASSWORD=your-password \
  -e BETTERDB_LICENSE_KEY=your-license-key \
  -e STORAGE_TYPE=memory \
  betterdb/monitor
```

**Important**: When not using `--network host`, the `-p` flag port mapping must match the `PORT` environment variable (e.g., `-p 8080:8080 -e PORT=8080`).

#### Host Network Mode

If your Valkey and PostgreSQL are running on the same host:

```bash
docker run -d \
  --name betterdb-monitor \
  --network host \
  -e DB_HOST=localhost \
  -e DB_PORT=6380 \
  -e DB_PASSWORD=devpassword \
  -e BETTERDB_LICENSE_KEY=your-license-key \
  -e STORAGE_TYPE=postgres \
  -e STORAGE_URL=postgresql://dev:devpass@localhost:5432/postgres \
  betterdb/monitor
```

**Note**: With `--network host`, no `-p` flag is needed. The application uses the `PORT` environment variable directly (default: 3001).

### Accessing the Application

Once running, access the web interface at:

- **Web UI**: `http://localhost:3001` (or your custom port)
- **Health Check**: `http://localhost:3001/health`
- **Prometheus Metrics**: `http://localhost:3001/prometheus/metrics`

## HTTP Endpoints

| Endpoint | Description |
|----------|-------------|
| `/` | Web UI dashboard |
| `/health` | Health check endpoint |
| `/api` | Swagger/OpenAPI documentation |
| `/prometheus/metrics` | Prometheus metrics endpoint |

All API endpoints are prefixed with `/api` when accessed through the web server.

### Health

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health status of API server, Valkey/Redis, and storage backend |

### Version

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/version` | GET | Current and latest version info, update availability |

### Settings

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/settings` | GET | Get current application settings |
| `/settings` | PUT | Update application settings |
| `/settings/reset` | POST | Reset settings to defaults from environment variables |

### Audit Trail

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/audit/entries` | GET | Get ACL audit log entries with optional filters |
| `/audit/stats` | GET | Get aggregated audit statistics |
| `/audit/failed-auth` | GET | Get failed authentication attempts |
| `/audit/by-user` | GET | Get audit entries for a specific username |

### Client Analytics

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/client-analytics/snapshots` | GET | Get historical client connection snapshots |
| `/client-analytics/timeseries` | GET | Get aggregated client counts over time |
| `/client-analytics/stats` | GET | Get client analytics statistics |
| `/client-analytics/history` | GET | Get connection history for specific client |
| `/client-analytics/cleanup` | DELETE | Manually trigger cleanup of old data |
| `/client-analytics/command-distribution` | GET | Get command frequency distribution by client |
| `/client-analytics/idle-connections` | GET | Identify connections idle for extended periods |
| `/client-analytics/buffer-anomalies` | GET | Detect clients with unusual buffer sizes |
| `/client-analytics/activity-timeline` | GET | Get activity over time for correlation |
| `/client-analytics/spike-detection` | GET | Automatically detect unusual activity spikes |

### Metrics

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/metrics/info` | GET | Parsed INFO command output |
| `/metrics/slowlog` | GET | Slowlog entries |
| `/metrics/slowlog/length` | GET | Current slowlog length |
| `/metrics/slowlog` | DELETE | Reset slowlog |
| `/metrics/slowlog/patterns` | GET | Aggregated slowlog pattern analysis |
| `/metrics/commandlog` | GET | Commandlog entries (Valkey 8.1+) |
| `/metrics/commandlog/length` | GET | Commandlog length (Valkey 8.1+) |
| `/metrics/commandlog` | DELETE | Reset commandlog (Valkey 8.1+) |
| `/metrics/commandlog/patterns` | GET | Commandlog pattern analysis (Valkey 8.1+) |
| `/metrics/latency/latest` | GET | Latest latency monitoring events |
| `/metrics/latency/history/:eventName` | GET | Latency history for specific event |
| `/metrics/latency/histogram` | GET | Latency histogram for commands |
| `/metrics/latency/doctor` | GET | Automated latency analysis report |
| `/metrics/latency` | DELETE | Reset latency monitoring data |
| `/metrics/memory/stats` | GET | Detailed memory usage statistics |
| `/metrics/memory/doctor` | GET | Automated memory analysis report |
| `/metrics/clients` | GET | List of currently connected clients |
| `/metrics/clients/:id` | GET | Information about specific client |
| `/metrics/clients` | DELETE | Terminate client connections |
| `/metrics/acl/log` | GET | ACL security log entries |
| `/metrics/acl/log` | DELETE | Clear ACL log |
| `/metrics/role` | GET | Replication role and status |
| `/metrics/cluster/info` | GET | Cluster information and status |
| `/metrics/cluster/nodes` | GET | Information about all cluster nodes |
| `/metrics/cluster/slot-stats` | GET | Per-slot statistics (Valkey 8.0+) |
| `/metrics/config` | GET | Configuration values matching pattern |
| `/metrics/config/:parameter` | GET | Value of specific config parameter |
| `/metrics/dbsize` | GET | Number of keys in current database |
| `/metrics/lastsave` | GET | Unix timestamp of last RDB save |

### Prometheus

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/prometheus/metrics` | GET | Prometheus-formatted metrics for scraping |

## Runtime Settings

The following settings can be modified at runtime via the `/settings` API endpoint without requiring an application restart:

| Setting | Default | Description |
|---------|---------|-------------|
| `auditPollIntervalMs` | `60000` | ACL audit log polling interval (milliseconds) |
| `clientAnalyticsPollIntervalMs` | `60000` | Client analytics data collection interval (milliseconds) |
| `anomalyPollIntervalMs` | `1000` | Anomaly detection polling interval (milliseconds) |
| `anomalyCacheTtlMs` | `3600000` | Anomaly detection cache TTL (milliseconds) |
| `anomalyPrometheusIntervalMs` | `30000` | Prometheus summary update interval (milliseconds) |

### Example: Update Settings

```bash
curl -X PUT http://localhost:3001/settings \
  -H "Content-Type: application/json" \
  -d '{
    "auditPollIntervalMs": 30000,
    "clientAnalyticsPollIntervalMs": 45000
  }'
```

Settings are persisted to the storage backend (PostgreSQL or SQLite) and survive restarts. When using `STORAGE_TYPE=memory`, settings revert to environment variable defaults on restart.

## Container Management

### View Logs

```bash
docker logs -f betterdb-monitor
```

### Stop Container

```bash
docker stop betterdb-monitor
```

### Remove Container

```bash
docker rm betterdb-monitor
```

### Replace Running Container

Automatically remove existing container and start a new one:

```bash
docker rm -f betterdb-monitor 2>/dev/null; docker run -d \
  --name betterdb-monitor \
  -p 3001:3001 \
  -e DB_HOST=your-valkey-host \
  -e DB_PORT=6379 \
  -e DB_PASSWORD=your-password \
  -e BETTERDB_LICENSE_KEY=your-license-key \
  -e STORAGE_TYPE=postgres \
  -e STORAGE_URL=postgresql://user:pass@postgres-host:5432/dbname \
  betterdb/monitor
```

### Inspect Container

```bash
# View container details
docker inspect betterdb-monitor

# View container stats
docker stats betterdb-monitor

# View container port mappings
docker port betterdb-monitor
```

## Docker Image Details

- **Base Image**: `node:25-alpine`
- **Size**: ~188MB (optimized, no build tools)
- **Platforms**: `linux/amd64`, `linux/arm64`
- **Contains**: Backend API + Frontend static files (served by Fastify)
- **Excluded**: SQLite support (use PostgreSQL or Memory storage)

## Health Check

The Docker image includes a built-in health check that runs every 30 seconds:

```bash
# View health status
docker inspect --format='{{json .State.Health}}' betterdb-monitor
```

The health check validates that the HTTP server is responding on the configured `PORT`.
