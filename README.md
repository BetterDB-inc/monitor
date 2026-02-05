# BetterDB Monitor

A monorepo application for monitoring Valkey/Redis databases with a NestJS backend and React frontend.

BetterDB is built by [BetterDB Inc.](https://betterdb.com), a public benefit company operating under the [OCV Open Charter](https://github.com/OpenCoreVentures/ocv-public-benefit-company).

## Project Structure

```
betterdb-monitor/
├── apps/
│   ├── api/                 # NestJS backend (Fastify)
│   └── web/                 # React frontend (Vite)
├── packages/
│   ├── cli/                 # CLI package (npx betterdb)
│   └── shared/              # Shared TypeScript types
├── docker-compose.yml       # Local Valkey (port 6380) and Redis (port 6382) for testing
└── package.json             # Workspace root
```

## Tech Stack

### Backend
- **NestJS** with Fastify adapter
- **iovalkey** for Valkey/Redis connections
- TypeScript with strict mode
- Runs on port **3001**

### Frontend
- **React** with TypeScript
- **Vite** for build tooling
- **TailwindCSS** for styling
- **Recharts** for data visualization
- Runs on port **5173**

### Monorepo
- **pnpm workspaces** for dependency management
- **Turborepo** for build orchestration

## Quick Start

### Prerequisites
- Node.js >= 20.0.0
- pnpm >= 9.0.0
- Docker (for local Valkey or Redis instances)

### Installation

1. Install dependencies:
```bash
pnpm install
```

2. Copy environment variables:
```bash
cp .env.example .env
```

3. Start local database instances (Valkey on 6380, Redis on 6382):
```bash
pnpm docker:up
```

To connect to Redis instead of Valkey, update `.env`:
```env
DB_PORT=6382
```

4. Start development servers:
```bash
pnpm dev
```

The application will be available at:
- Frontend: http://localhost:5173
- Backend API: http://localhost:3001

### Individual Commands

Run only the API:
```bash
pnpm dev:api
```

Run only the web frontend:
```bash
pnpm dev:web
```

Stop Docker containers:
```bash
pnpm docker:down
```

Build for production:
```bash
pnpm build
```

## CLI Installation (npx)

The easiest way to run BetterDB Monitor without Docker:

```bash
npx betterdb
```

On first run, an interactive setup wizard will guide you through configuration:
- Database connection (host, port, credentials)
- Storage backend (SQLite, PostgreSQL, or in-memory)
- Server port and other settings

Configuration is saved to `~/.betterdb/config.json`.

### Global Installation

```bash
npm install -g betterdb
betterdb
```

### CLI Options

```bash
betterdb --setup           # Re-run setup wizard, then start server
betterdb --port 8080       # Override server port
betterdb --db-host 1.2.3.4 # Override database host
betterdb --help            # Show all options
```

### SQLite Storage (Optional)

To use SQLite storage with the CLI, install `better-sqlite3`:

```bash
npm install -g better-sqlite3
```

### Requirements

- Node.js >= 20.0.0
- A Valkey or Redis instance to monitor

---

## Docker Production Deployment

### Building the Docker Image

```bash
pnpm docker:build
```

For multi-arch builds (AMD64 + ARM64), first set up buildx:

```bash
docker buildx create --name mybuilder --use --bootstrap
```

Then build:

```bash
pnpm docker:build:multiarch
```

### Running the Docker Container

The Docker image contains only the monitoring application (backend + frontend). It requires:
1. A Valkey/Redis instance to monitor
2. A PostgreSQL instance for data persistence (or use memory storage)

#### Basic Run (Memory Storage)

```bash
docker run -d \
  --name betterdb-monitor \
  -p 3001:3001 \
  -e DB_HOST=your-valkey-host \
  -e DB_PORT=6379 \
  -e DB_PASSWORD=your-password \
  -e STORAGE_TYPE=memory \
  betterdb/monitor
```

#### Run on Custom Port

You can run the application on any port by setting the `PORT` environment variable with `-e PORT=<port>`:

```bash
docker run -d \
  --name betterdb-monitor \
  -p 8080:8080 \
  -e PORT=8080 \
  -e DB_HOST=your-valkey-host \
  -e DB_PORT=6379 \
  -e DB_PASSWORD=your-password \
  -e STORAGE_TYPE=memory \
  betterdb/monitor
```

**Note**: When not using `--network host`, make sure the `-p` flag port mapping matches the `PORT` environment variable (e.g., `-p 8080:8080 -e PORT=8080`).

#### Run with PostgreSQL Storage

```bash
docker run -d \
  --name betterdb-monitor \
  -p 3001:3001 \
  -e DB_HOST=your-valkey-host \
  -e DB_PORT=6379 \
  -e DB_PASSWORD=your-password \
  -e STORAGE_TYPE=postgres \
  -e STORAGE_URL=postgresql://user:pass@postgres-host:5432/dbname \
  betterdb/monitor
```

#### Run with Host Network (Access localhost services)

If your Valkey and PostgreSQL are running on the same host:

```bash
docker run -d \
  --name betterdb-monitor \
  --network host \
  -e DB_HOST=localhost \
  -e DB_PORT=6380 \
  -e DB_PASSWORD=devpassword \
  -e STORAGE_TYPE=postgres \
  -e STORAGE_URL=postgresql://dev:devpass@localhost:5432/postgres \
  betterdb/monitor
```

#### Auto-Remove Previous Container

To automatically remove any existing container with the same name:

```bash
docker rm -f betterdb-monitor 2>/dev/null; docker run -d \
  --name betterdb-monitor \
  -p 3001:3001 \
  -e DB_HOST=your-valkey-host \
  -e DB_PORT=6379 \
  -e DB_PASSWORD=your-password \
  -e STORAGE_TYPE=postgres \
  -e STORAGE_URL=postgresql://user:pass@postgres-host:5432/dbname \
  betterdb/monitor
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DB_HOST` | Yes | `localhost` | Valkey/Redis host to monitor |
| `DB_PORT` | No | `6379` | Valkey/Redis port |
| `DB_PASSWORD` | No | - | Valkey/Redis password |
| `DB_USERNAME` | No | `default` | Valkey/Redis ACL username |
| `DB_TYPE` | No | `auto` | Database type: `auto`, `valkey`, or `redis` |
| `STORAGE_TYPE` | No | `memory` | Storage backend: `memory` or `postgres` |
| `STORAGE_URL` | Conditional | - | PostgreSQL connection URL (required if `STORAGE_TYPE=postgres`) |
| `PORT` | No | `3001` | Application HTTP port |
| `NODE_ENV` | No | `production` | Node environment |
| `ANOMALY_DETECTION_ENABLED` | No | `true` | Enable anomaly detection |
| `ANOMALY_PROMETHEUS_INTERVAL_MS` | No | `30000` | Prometheus summary update interval (ms) |

### Accessing the Application

Once running, access the web interface at:
- **Web UI**: `http://localhost:3001`
- **Health Check**: `http://localhost:3001/health`
- **Prometheus Metrics**: `http://localhost:3001/prometheus/metrics`

### Docker Image Details

- **Base Image**: `node:20-alpine`
- **Size**: ~188MB (optimized, no build tools)
- **Platforms**: `linux/amd64`, `linux/arm64`
- **Contains**: Backend API + Frontend static files (served by Fastify)
- **Excluded**: SQLite support (use PostgreSQL or Memory storage)

### Checking Container Logs

```bash
docker logs -f betterdb-monitor
```

### Stopping the Container

```bash
docker stop betterdb-monitor
docker rm betterdb-monitor
```

## Features

### Current Features
- Database connection health monitoring
- Auto-detection of Valkey vs Redis
- Version detection
- Capability detection (Command Log, Slot Stats)
- Auto-refresh every 5 seconds
- Full Redis 6.x and 7.x support (85-90% feature parity with Valkey)
- Graceful degradation for Valkey-only features

### Supported Database Versions

| Database | Minimum Version | Supported Features |
|----------|----------------|-------------------|
| **Valkey** | 8.0+ | All features including COMMANDLOG and CLUSTER SLOT-STATS |
| **Redis** | 6.0+ | All features except COMMANDLOG and CLUSTER SLOT-STATS |

### Feature Compatibility Matrix

| Feature | Command | Valkey | Redis |
|---------|---------|--------|-------|
| Server Info | `INFO` | Yes | Yes |
| Health Check | `PING` | Yes | Yes |
| Slowlog | `SLOWLOG` | Yes | Yes (2.2+) |
| Client List | `CLIENT LIST` | Yes | Yes (2.4+) |
| Latency Monitor | `LATENCY` | Yes | Yes (2.8+) |
| Memory Stats | `MEMORY STATS` | Yes | Yes (4.0+) |
| ACL Log | `ACL LOG` | Yes | Yes (6.0+) |
| Command Log | `COMMANDLOG` | Yes (8.1+) | No (Valkey-only) |
| Cluster Slot Stats | `CLUSTER SLOT-STATS` | Yes (8.0+) | No (Valkey-only) |

### Architecture Highlights

**Unified Adapter Pattern**: The backend uses a unified `UnifiedDatabaseAdapter` that works seamlessly with both Valkey and Redis through the wire-compatible `iovalkey` client library.

**Auto-detection**: The application automatically detects whether it's connecting to Valkey or Redis by inspecting the `INFO` response.

**Capability Detection**: Features like Command Log (Valkey 8.1+) and Slot Stats (Valkey 8.0+) are automatically detected based on database type and version. The UI gracefully degrades when connecting to Redis, showing only supported features.

**Graceful Degradation**: When connected to Redis, Valkey-specific features return clear error messages indicating they're not supported, while all shared features work identically.

## Prometheus Metrics

Metrics are exposed at `GET /prometheus/metrics` in Prometheus text format.

### ACL Audit Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `betterdb_acl_denied` | gauge | - | Total ACL denied events captured |
| `betterdb_acl_denied_by_reason` | gauge | `reason` | ACL denied events by reason |
| `betterdb_acl_denied_by_user` | gauge | `username` | ACL denied events by username |

### Client Connection Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `betterdb_client_connections_current` | gauge | - | Current number of client connections |
| `betterdb_client_connections_peak` | gauge | - | Peak connections in retention period |
| `betterdb_client_connections_by_name` | gauge | `client_name` | Current connections by client name |
| `betterdb_client_connections_by_user` | gauge | `user` | Current connections by ACL user |

### Slowlog Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `betterdb_slowlog_pattern_count` | gauge | `pattern` | Number of slow queries per pattern |
| `betterdb_slowlog_pattern_avg_duration_us` | gauge | `pattern` | Average duration in microseconds per pattern |
| `betterdb_slowlog_pattern_percentage` | gauge | `pattern` | Percentage of slow queries per pattern |

### COMMANDLOG Metrics (Valkey 8.1+)

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `betterdb_commandlog_large_request` | gauge | - | Total large request entries |
| `betterdb_commandlog_large_reply` | gauge | - | Total large reply entries |
| `betterdb_commandlog_large_request_by_pattern` | gauge | `pattern` | Large request count by command pattern |
| `betterdb_commandlog_large_reply_by_pattern` | gauge | `pattern` | Large reply count by command pattern |

### Node.js Process Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `betterdb_process_cpu_user_seconds_total` | counter | - | Total user CPU time spent in seconds |
| `betterdb_process_cpu_system_seconds_total` | counter | - | Total system CPU time spent in seconds |
| `betterdb_process_cpu_seconds_total` | counter | - | Total user and system CPU time spent in seconds |
| `betterdb_process_start_time_seconds` | gauge | - | Start time of the process since unix epoch in seconds |
| `betterdb_process_resident_memory_bytes` | gauge | - | Resident memory size in bytes |
| `betterdb_process_virtual_memory_bytes` | gauge | - | Virtual memory size in bytes |
| `betterdb_process_heap_bytes` | gauge | - | Process heap size in bytes |
| `betterdb_process_open_fds` | gauge | - | Number of open file descriptors |
| `betterdb_process_max_fds` | gauge | - | Maximum number of open file descriptors |

### Node.js Event Loop Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `betterdb_nodejs_eventloop_lag_seconds` | gauge | - | Lag of event loop in seconds |
| `betterdb_nodejs_eventloop_lag_min_seconds` | gauge | - | Minimum recorded event loop delay |
| `betterdb_nodejs_eventloop_lag_max_seconds` | gauge | - | Maximum recorded event loop delay |
| `betterdb_nodejs_eventloop_lag_mean_seconds` | gauge | - | Mean of recorded event loop delays |
| `betterdb_nodejs_eventloop_lag_stddev_seconds` | gauge | - | Standard deviation of recorded event loop delays |
| `betterdb_nodejs_eventloop_lag_p50_seconds` | gauge | - | 50th percentile of recorded event loop delays |
| `betterdb_nodejs_eventloop_lag_p90_seconds` | gauge | - | 90th percentile of recorded event loop delays |
| `betterdb_nodejs_eventloop_lag_p99_seconds` | gauge | - | 99th percentile of recorded event loop delays |

### Node.js Runtime Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `betterdb_nodejs_active_resources` | gauge | `type` | Active resources keeping the event loop alive |
| `betterdb_nodejs_active_resources_total` | gauge | - | Total number of active resources |
| `betterdb_nodejs_active_handles` | gauge | `type` | Active libuv handles by type |
| `betterdb_nodejs_active_handles_total` | gauge | - | Total number of active handles |
| `betterdb_nodejs_active_requests` | gauge | `type` | Active libuv requests by type |
| `betterdb_nodejs_active_requests_total` | gauge | - | Total number of active requests |
| `betterdb_nodejs_version_info` | gauge | `version`, `major`, `minor`, `patch` | Node.js version info |

### Node.js Heap Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `betterdb_nodejs_heap_size_total_bytes` | gauge | - | Process heap size from Node.js in bytes |
| `betterdb_nodejs_heap_size_used_bytes` | gauge | - | Process heap size used from Node.js in bytes |
| `betterdb_nodejs_external_memory_bytes` | gauge | - | Node.js external memory size in bytes |
| `betterdb_nodejs_heap_space_size_total_bytes` | gauge | `space` | Process heap space size total in bytes |
| `betterdb_nodejs_heap_space_size_used_bytes` | gauge | `space` | Process heap space size used in bytes |
| `betterdb_nodejs_heap_space_size_available_bytes` | gauge | `space` | Process heap space size available in bytes |

### Node.js GC Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `betterdb_nodejs_gc_duration_seconds` | histogram | `kind` | Garbage collection duration (major, minor, incremental, weakcb) |

## Configuration

### Database Connection (Valkey/Redis)

Edit `.env` to configure the Valkey/Redis database connection:

```env
DB_HOST=localhost
DB_PORT=6379
DB_USERNAME=default
DB_PASSWORD=devpassword
DB_TYPE=auto  # 'valkey' | 'redis' | 'auto'
```

### Storage Backend

BetterDB Monitor supports multiple storage backends for persisting audit trail and client analytics data:

#### SQLite (Local Development Only)
```bash
STORAGE_TYPE=sqlite
STORAGE_SQLITE_FILEPATH=./data/audit.db  # Optional, defaults to this path
```
- **Use Case**: Local development
- **Pros**: No external database required, simple setup
- **Cons**: Not available in Docker production builds
- **Data Location**: `apps/api/data/audit.db`

#### PostgreSQL (Recommended for Production)
```bash
STORAGE_TYPE=postgres
STORAGE_URL=postgresql://username:password@host:port/database
```
- **Use Case**: Production and local development
- **Pros**: Full relational database, better for production workloads
- **Cons**: Requires PostgreSQL instance
- **Example**: `postgresql://dev:devpass@localhost:5432/postgres`

#### Memory (Testing/Ephemeral)
```bash
STORAGE_TYPE=memory
```
- **Use Case**: Testing, ephemeral environments
- **Pros**: No persistence required, fast
- **Cons**: All data lost on restart

### Running Locally with Different Storage Backends

#### With SQLite:
```bash
STORAGE_TYPE=sqlite \
DB_HOST=localhost \
DB_PORT=6380 \
DB_PASSWORD=devpassword \
pnpm dev:api
```

#### With PostgreSQL:
```bash
# Start PostgreSQL (if using docker-compose)
docker compose up -d postgres

# Run API with PostgreSQL
STORAGE_TYPE=postgres \
STORAGE_URL=postgresql://betterdb:devpassword@localhost:5432/betterdb \
DB_HOST=localhost \
DB_PORT=6380 \
DB_PASSWORD=devpassword \
pnpm dev:api
```

#### With Memory:
```bash
STORAGE_TYPE=memory \
DB_HOST=localhost \
DB_PORT=6380 \
DB_PASSWORD=devpassword \
pnpm dev:api
```

## Development

### Adding New Features

The codebase is structured to make it easy to add new monitoring features:

1. Add new endpoints in `apps/api/src/`
2. Add corresponding API calls in `apps/web/src/api/`
3. Add shared types in `packages/shared/src/types/`

### Code Style

- TypeScript strict mode is enabled
- Explicit return types required on functions
- No `any` types allowed
- ESLint + Prettier configured

## License

MIT
