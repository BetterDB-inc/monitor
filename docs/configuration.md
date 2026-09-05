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
  - [Authenticating API Requests](#authenticating-api-requests)
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

### Cloud: Direct Connection Network Requirements

When using **BetterDB Cloud**, each workspace runs in an isolated container with a restricted outbound network policy. The following port ranges are permitted for direct database connections:

| Port range  | Protocol | Use case                                                                |
| ----------- | -------- | ----------------------------------------------------------------------- |
| `443`       | TCP      | HTTPS/TLS connections                                                   |
| `2000–2999` | TCP      | Managed Redis/Valkey providers that use ports in this range             |
| `6000–6999` | TCP      | Standard Redis/Valkey (6379), TLS (6380), Azure Enterprise (6380), etc. |

A small number of sensitive infrastructure ports within these ranges are blocked (e.g. 2375–2376, 2379–2380, 6443). If your database runs on a port outside these ranges, use the [BetterDB Agent](./agent-connection.md) instead — the agent runs in your own network and connects outbound on port 443, so there are no port restrictions on your side.

> **Tip**: Most managed services (Upstash, Redis Cloud, Aiven) use port 6379 with TLS — enable the **Use TLS** toggle in the connection form and they will work with direct connection.

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

| Variable      | Required | Default     | Description                                 |
| ------------- | -------- | ----------- | ------------------------------------------- |
| `DB_HOST`     | Yes      | `localhost` | Valkey/Redis host to monitor                |
| `DB_PORT`     | No       | `6379`      | Valkey/Redis port                           |
| `DB_USERNAME` | No       | `default`   | Valkey/Redis ACL username                   |
| `DB_PASSWORD` | No       | -           | Valkey/Redis password                       |
| `DB_TYPE`     | No       | `auto`      | Database type: `auto`, `valkey`, or `redis` |

### Storage Backend

| Variable                  | Required    | Default           | Description                                                                                                                                                                                                       |
| ------------------------- | ----------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STORAGE_TYPE`            | No          | `memory`          | Storage backend: `memory`, `postgres`, `sqlite`, or `turso`                                                                                                                                                       |
| `STORAGE_URL`             | Conditional | -                 | PostgreSQL connection URL (required if `STORAGE_TYPE=postgres`), or libSQL URL (required if `STORAGE_TYPE=turso`)                                                                                                 |
| `STORAGE_AUTH_TOKEN`      | Conditional | -                 | Turso auth token (startup requires it when `STORAGE_URL` uses `libsql://`, and rejects it when `STORAGE_URL` uses `http://`; a hosted `https://` endpoint needs it too but is not checked at startup - see below) |
| `STORAGE_SQLITE_FILEPATH` | No          | `./data/audit.db` | SQLite database file path (only for `STORAGE_TYPE=sqlite`)                                                                                                                                                        |

**Warning**: `memory` is for development and testing only. Users and sessions live in the process, so a restart loses them, the instance returns to the register screen, and the next visitor claims the owner account. Use `sqlite` or `postgres` for anything other people can reach.

**Note**: `sqlite` writes to a local file through the `better-sqlite3` native module, which is stripped from the `latest` (no-AI) Docker image - use it for local development, or pick `postgres`, `turso`, or `memory` for Docker deployments.

**Note**: `turso` reuses the SQLite adapter over the libSQL wire protocol, so it needs no native module and works in every Docker image. It is opt-in: set `STORAGE_TYPE=turso` plus `STORAGE_URL` (and `STORAGE_AUTH_TOKEN` for `libsql://` URLs), exactly like the `postgres` backend.

**Note**: `http://` is for an unauthenticated local `sqld` only. An auth token on an `http://` URL is rejected at startup, because libSQL sends it as given and the token would cross the network in cleartext.

**Note**: only `libsql://` makes the auth token a startup requirement. `https://` and `http://` are also accepted so a self-hosted or local `sqld` can run without one, which means a hosted `https://` Turso URL with a missing or empty `STORAGE_AUTH_TOKEN` starts cleanly and fails on the first query instead. If a `turso` deployment starts and then reports auth errors on every read, check the token before anything else.

### Application Settings

| Variable   | Required | Default      | Description                                      |
| ---------- | -------- | ------------ | ------------------------------------------------ |
| `PORT`     | No       | `3001`       | Application HTTP port                            |
| `NODE_ENV` | No       | `production` | Node environment (`production` or `development`) |

### Security

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ENCRYPTION_KEY` | No | - | Master key for encrypting stored connection passwords **and SSH tunnel secrets** (min 16 characters) |
| `ENCRYPTION_KEK_SALT` | No | `betterdb-kek-salt-v1` | Salt used for key derivation (customize for additional security) |
| `WORKSPACE_DISABLED` | No | `false` | Run without user control: no login, no roles, no Team page. Existing installs upgrading with the default see a register screen on first load |
| `AUTH_SECRET` | No | generated | Session signing secret, at least 32 characters. Generated once and stored in `BETTERDB_DATA_DIR/auth-secret` when unset; set it explicitly when running more than one replica. When the data directory is read-only the API keeps booting with an in-memory secret and logs a warning: sessions are then invalidated on every restart |
| `AUTH_PUBLIC_URL` | No | inferred | Public origin used for session cookies and CSRF origin checks, e.g. `https://monitor.example.com`. When unset, the origin check accepts the host the request carries under either scheme; setting it pins the check to this origin. Session cookies are marked `Secure` only when this starts with `https://`, so installs served over HTTPS (including behind a TLS-terminating proxy) should set it and keep session cookies off plain HTTP |
| `TRUST_PROXY` | No | `false` | Trust `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto`. Set to a comma-separated list of proxy addresses/CIDRs (`10.0.0.0/8,127.0.0.1`) so client IPs, rate limits and the CSRF origin check see the browser-facing host, or to `true` when the API is only reachable through the proxy. A hop count (`1`) is refused with a warning: Fastify's hop-count matching ignores the connecting address, so anyone who reaches the API directly can spoof the headers. Leave unset when the API is reachable directly |
| `AUTH_BROKER_URL` | No | `https://betterdb.com` | Origin of the BetterDB sign-in broker (used from phase 5) |
| `ACTIVITY_RETENTION_DAYS` | No | `90` | Days to keep activity log rows (API mutations, browser CLI commands, sign-ins and sign-outs). Older rows are deleted once a day and at startup |

**Roles**: The first account to register becomes the workspace owner, who holds the `admin` role. Admins can change anything. Members are read-only: every `POST`, `PUT`, `PATCH`, and `DELETE` request answers `403` except signing in/out and a small set of read-only `POST` endpoints (vector-search similarity search, profiling, and full-text search, plus the monitor session preflight check, which run a query but do not mutate data). The browser CLI and the monitor tail both require a signed-in session — an unauthenticated socket is rejected before the WebSocket handshake completes — and a member's CLI session is restricted to read-only commands regardless of `BETTERDB_UNSAFE_CLI`; `CONFIG`, `ACL`, `DEBUG`, and `CLIENT` are refused for members outright because they expose server configuration and credentials, and `SLOWLOG RESET`, `COMMANDLOG RESET`, and `LATENCY RESET` are refused because they clear diagnostic state. Members can read monitor capture sessions, including the live tail; captured values are redacted only when `MONITOR_REDACT_VALUES=true`.

**Invitations**: Admins add people from the Team page. Creating an invitation returns a one-time link (`<AUTH_PUBLIC_URL>/invite/<token>`, or the requesting origin when `AUTH_PUBLIC_URL` is unset) that the admin copies and sends by any channel; the monitor sends no email. The link is shown once, expires after 7 days, and is stored only as a hash. Opening it shows the invited email and role; the invitee sets a name and password and is signed in as a `member` or `admin` according to the invitation. Admins can revoke pending invitations; re-inviting an email whose earlier invitation was revoked, accepted or expired issues a fresh link. The owner can change any other member's role, remove members (which ends their sessions), and transfer ownership; the previous owner then remains an admin. Public registration stays closed after the first account.

**Activity log**: Every `POST`, `PUT`, `PATCH`, and `DELETE` request made by a signed-in user is recorded with the user, the source IP, the connection (`X-Connection-Id`), the route, the response status and, where the route has one, the affected object (a connection id, an invitation id, a member id, a bulk-delete job id). Sign-ins, sign-outs and invitation acceptances are recorded as `auth.login` / `auth.logout`, and every browser CLI command as `cli.command` with the command name and argument count (argument values are kept only for read commands, never for `AUTH`, `HELLO`,
`CONFIG`, `ACL` or `MIGRATE`, and at most the first 16 arguments of 128 characters each). Requests the server refuses with `401` or `403` are not recorded. Admins read the log from the Activity tab of the Team page or from `GET /api/workspace/activity` (`actor`, `action`, `from`, `to`, `cursor`, `limit` ≤ 100), and rows are kept for `ACTIVITY_RETENTION_DAYS`.

**Password Encryption**: When `ENCRYPTION_KEY` is set, all connection passwords are encrypted at rest using envelope encryption (AES-256-GCM). Each password gets a unique encryption key (DEK) that is itself encrypted with a master key (KEK) derived from your `ENCRYPTION_KEY`. The same encryption covers SSH tunnel secrets (SSH password, key passphrase, and inline private keys).

- If not set, passwords are stored in plaintext (a warning is logged at startup)
- Use a strong, random key (e.g., `openssl rand -base64 32`)
- Store the key securely (e.g., in a secrets manager)
- If you lose the key, encrypted passwords cannot be recovered
- Optionally set `ENCRYPTION_KEK_SALT` to a custom value for defense-in-depth (attackers would need both key and salt)

### SSH Tunnels

A connection can reach its database through an SSH bastion/jump host (single hop) instead of connecting directly. Configure it per-connection via the web UI ("Connect via SSH tunnel") or the connection API (`sshTunnel` field). Authentication is a password or a private key.

| Variable               | Required | Default | Description                                                                                                                                                                                              |
| ---------------------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTERDB_SSH_KEY_DIR` | No       | -       | Directory that server-side SSH private keys must live in. Enables the "server file path" key source; a connection's `privateKeyPath` must resolve inside this directory. Unset disables file-based keys. |

**Private key sources**:

- **Inline (paste key)** — the PEM key content is submitted with the connection. It is encrypted at rest **only when `ENCRYPTION_KEY` is set**; without it, the key (like connection passwords) is stored in plaintext and a warning is logged at startup. Works in any deployment, including managed/cloud.
- **Server file path** — the key already exists on the monitor server's filesystem. Set `BETTERDB_SSH_KEY_DIR` to the directory holding allowed keys; the connection's `privateKeyPath` is resolved relative to it and rejected if it escapes the directory (no path traversal). Best for self-hosted deployments that mount keys as a secret volume.

**Host key verification**: pin the SSH server's SHA256 host-key fingerprint on the connection (`hostKeyFingerprint`, e.g. `SHA256:...` from `ssh-keyscan -t ed25519 HOST | ssh-keygen -lf -`). When set, the tunnel is refused unless the server presents a matching key, which prevents a man-in-the-middle on the bastion path. When left unset the server key is accepted and a warning is logged.

The Valkey/Redis client connects to `127.0.0.1:<local-forwarded-port>` through the tunnel. When TLS is enabled, the certificate is still validated against the real database hostname (SNI `servername`), not localhost.

**Host key verification (TOFU):** if you leave `hostKeyFingerprint` unset, the SSH server's key is trusted on first connect and then pinned automatically — subsequent connects are refused if the key changes. Pin the fingerprint up front (see above) to avoid trusting the first key blind.

**Password auth:** password and keyboard-interactive (PAM) bastions are both supported; a password is answered to interactive prompts automatically.

**Known limitation — cluster/Sentinel:** only the configured connection is tunnelled. Cluster/Sentinel monitoring connects to peer nodes at the addresses they advertise, directly rather than through the tunnel, so nodes reachable only via the bastion (e.g. ElastiCache/MemoryDB in a private subnet) will not have per-node views. Use tunnels for single-node/primary monitoring.

### Audit Trail

| Variable                 | Required | Default | Description                               |
| ------------------------ | -------- | ------- | ----------------------------------------- |
| `AUDIT_POLL_INTERVAL_MS` | No       | `60000` | ACL audit polling interval (milliseconds) |

### Anomaly Detection

| Variable                         | Required | Default   | Description                                           |
| -------------------------------- | -------- | --------- | ----------------------------------------------------- |
| `ANOMALY_DETECTION_ENABLED`      | No       | `true`    | Enable anomaly detection features (Pro tier required) |
| `ANOMALY_POLL_INTERVAL_MS`       | No       | `1000`    | Anomaly detection polling interval (milliseconds)     |
| `ANOMALY_CACHE_TTL_MS`           | No       | `3600000` | Anomaly detection cache TTL (milliseconds)            |
| `ANOMALY_PROMETHEUS_INTERVAL_MS` | No       | `30000`   | Prometheus summary update interval (milliseconds)     |

### Client Analytics

| Variable                            | Required | Default | Description                                      |
| ----------------------------------- | -------- | ------- | ------------------------------------------------ |
| `CLIENT_ANALYTICS_POLL_INTERVAL_MS` | No       | `60000` | Client analytics polling interval (milliseconds) |

### Data Retention

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LOCAL_RETENTION_DAYS` | No | - | Self-hosted only: days of monitoring history to keep (daily sweep). Seeds the setting when the settings row is first created; unset = keep forever |

Self-hosted BetterDB keeps stored monitoring history **indefinitely by default**, bounded only by your storage backend's capacity and disk space. The retention window, once set, covers every store: slow log and command log entries, client/latency/memory snapshots, latency histograms, anomaly events and correlated groups, **ACL audit entries**, key pattern snapshots and hot keys, webhook deliveries, monitor captures (sessions, chunks, triggers, scheduled), AI cache samples, OTel spans, command/latency stats samples, and vector index snapshots.

To keep the database from growing forever, set a retention window from **Settings → Data Retention** in the UI. On a fresh install the window can also be seeded with `LOCAL_RETENTION_DAYS` — the env var applies only when the settings row is first created; after that the settings page owns the value, so clearing it there sticks even if the env var stays set. A daily sweep then deletes history older than the window, and the high-volume sample stores (command/latency stats samples, vector index snapshots, AI cache samples, OTel spans) are additionally trimmed to the same window on an hourly cycle. Nothing is deleted while the window is unset.

**BetterDB Cloud** applies the tier-based retention policy (Community 7 days, Pro 90, Enterprise 365) automatically; the local retention setting has no effect there.

### License Configuration

Pro/Enterprise features are unlocked with a license, and there are **two ways** to
provide one. Pick based on whether the monitor can reach the internet:

#### Option 1 — Online license key (default)

For monitors that can reach `betterdb.com`. Set your key; the monitor validates it
online and caches a **locally-verified signed token**, so your tier keeps working
through short outages (up to 7 days) and restarts.

```bash
-e BETTERDB_LICENSE_KEY=btdb_xxxxxxxxxxxxxxxx
```

#### Option 2 — Offline / air-gapped license token

For monitors with **no internet access**. Download a signed offline license token
from [betterdb.com/account/licenses](https://www.betterdb.com/account/licenses)
(Pro/Enterprise), and provide it as a mounted file or an inline string. The monitor
verifies it locally against embedded public keys and **never phones home** —
telemetry and update checks are automatically disabled.

```bash
# as a mounted file (recommended — pairs with a Docker/K8s secret mount)
-e BETTERDB_OFFLINE_LICENSE_FILE=/run/secrets/betterdb-license.jwt
# …or inline as a JWT string
-e BETTERDB_OFFLINE_LICENSE=eyJhbGciOiJSUzI1NiIs...
```

You can also paste/upload it at runtime: **Settings → License → “Air-gapped
environment? Activate an offline license.”** See
**[Offline & Air-Gapped Licenses](./offline-licenses.md)** for the full flow,
verification precedence, and key-rotation runbook.

| Variable                        | Required | Default                                        | Description                                                                                                                          |
| ------------------------------- | -------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `BETTERDB_LICENSE_KEY`          | No       | -                                              | Online license key (Option 1); validated against `ENTITLEMENT_URL`.                                                                  |
| `BETTERDB_OFFLINE_LICENSE`      | No       | -                                              | Offline license token as a JWT string (Option 2).                                                                                    |
| `BETTERDB_OFFLINE_LICENSE_FILE` | No       | -                                              | Path to an offline license `.jwt` (Option 2); falls back to `<data-dir>/license-offline.jwt`.                                        |
| `BETTERDB_DATA_DIR`             | No       | `/app/data` (Docker) / `./data` (local)        | Directory for persisted license state (`license.jwt`, `license-offline.jwt`, `license-clock.json`), written mode `0600`.             |
| `BETTERDB_TELEMETRY`            | No       | `true`                                         | Enable anonymous telemetry (set `false` to disable; force-disabled in air-gapped mode).                                              |
| `ENTITLEMENT_URL`               | No       | `https://www.betterdb.com/api/v1/entitlements` | Entitlement validation endpoint (Option 1).                                                                                          |
| `LICENSE_ALLOW_UNSIGNED`        | No       | `false`                                        | Accept unsigned entitlement responses from a legacy server. Use only during migration — an unsigned paid grant is otherwise refused. |
| `LICENSE_CACHE_TTL_MS`          | No       | `3600000`                                      | License cache TTL (milliseconds)                                                                                                     |
| `LICENSE_MAX_STALE_MS`          | No       | `604800000`                                    | Maximum stale license age (milliseconds)                                                                                             |
| `LICENSE_TIMEOUT_MS`            | No       | `10000`                                        | License validation timeout (milliseconds)                                                                                            |

> **Persisting license state (Docker/Kubernetes):** the signed-token outage grace
> (Option 1) and UI/runtime-activated offline licenses (Option 2) are written to the
> data directory — `/app/data` in the image. If you don't mount a volume there, that
> state is re-fetched online, or lost for air-gapped hosts, on every restart/upgrade.
> **The container runs as UID 1001** — a freshly-created volume mounts root-owned, so
> the monitor logs `EACCES … open '/app/data/license.jwt'` and can't persist. Make the
> volume writable by UID 1001 once:
>
> ```bash
> docker volume create betterdb-data
> docker run --rm -v betterdb-data:/d alpine chown 1001:1001 /d   # one-time
> docker run -d -v betterdb-data:/app/data -e BETTERDB_OFFLINE_LICENSE_FILE=... betterdb/monitor
> ```

**Telemetry**: BetterDB Monitor collects anonymous usage telemetry to help improve the product. No personally identifiable information is collected. The telemetry includes:

- Instance ID (deterministic hash derived from DB_HOST, DB_PORT, STORAGE_URL, and license key)
- Application version
- Platform and architecture (e.g., linux, x64)
- Node.js version
- License tier (community/pro/enterprise)

To disable telemetry, set `BETTERDB_TELEMETRY=false` in your environment variables.

### Version Update Checks

| Variable                    | Required | Default   | Description                                            |
| --------------------------- | -------- | --------- | ------------------------------------------------------ |
| `VERSION_CHECK_INTERVAL_MS` | No       | `3600000` | Version check interval (milliseconds, default: 1 hour) |

BetterDB Monitor automatically checks for new versions and displays an update banner in the web UI when a newer version is available. Version information is obtained from:

1. **Entitlement server** (piggybacked on license/telemetry requests) - primary source
2. **GitHub Releases API** - fallback when entitlement data is unavailable

### Key Analytics (Pro Tier)

| Variable                        | Required | Default  | Description                                      |
| ------------------------------- | -------- | -------- | ------------------------------------------------ |
| `KEY_ANALYTICS_SAMPLE_SIZE`     | No       | `10000`  | Number of keys to sample for analytics           |
| `KEY_ANALYTICS_SCAN_BATCH_SIZE` | No       | `1000`   | Batch size for key scanning operations           |
| `KEY_ANALYTICS_INTERVAL_MS`     | No       | `300000` | Key analytics collection interval (milliseconds) |

Key analytics history follows the standard retention policy (see [Data Retention](#data-retention)): self-hosted installs keep it until a retention window is configured; BetterDB Cloud prunes it at the tier window (Community 7 days, Pro 90, Enterprise 365).

**Note**: Key analytics features require a Pro tier license.

### AI Features (Experimental)

| Variable                    | Required | Default                  | Description                               |
| --------------------------- | -------- | ------------------------ | ----------------------------------------- |
| `AI_ENABLED`                | No       | `false`                  | Enable AI-powered features (chatbot, RAG) |
| `OLLAMA_BASE_URL`           | No       | `http://localhost:11434` | Ollama API endpoint for LLM inference     |
| `OLLAMA_KEEP_ALIVE`         | No       | `24h`                    | Keep-alive duration for Ollama models     |
| `AI_USE_LLM_CLASSIFICATION` | No       | `false`                  | Use LLM for anomaly classification        |
| `LANCEDB_PATH`              | No       | `./data/lancedb`         | Path to LanceDB vector database           |
| `VALKEY_DOCS_PATH`          | No       | `./data/valkey-docs`     | Path to indexed Valkey documentation      |

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

**Note**: `STORAGE_TYPE=memory` loses users and sessions on every restart, so the instance returns to the register screen and the next visitor claims the owner account. Use `sqlite` or `postgres` once other people can reach it.

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

#### Turso Storage

```bash
docker run -d \
  --name betterdb-monitor \
  -p 3001:3001 \
  -e DB_HOST=your-valkey-host \
  -e DB_PORT=6379 \
  -e DB_PASSWORD=your-password \
  -e BETTERDB_LICENSE_KEY=your-license-key \
  -e STORAGE_TYPE=turso \
  -e STORAGE_URL=libsql://your-db-your-org.turso.io \
  -e STORAGE_AUTH_TOKEN=your-turso-auth-token \
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

**Note**: `STORAGE_TYPE=memory` loses users and sessions on every restart, so the instance returns to the register screen and the next visitor claims the owner account. Use `sqlite` or `postgres` once other people can reach it.

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

#### Air-Gapped / Offline License

For hosts with no internet access, mount the offline license token and a writable
data volume (see [License Configuration](#license-configuration) for the details):

```bash
# one-time: make the data volume writable by the container's UID (1001)
docker volume create betterdb-data
docker run --rm -v betterdb-data:/d alpine chown 1001:1001 /d

docker run -d \
  --name betterdb-monitor \
  -p 3001:3001 \
  -e DB_HOST=your-valkey-host \
  -e DB_PORT=6379 \
  -e DB_PASSWORD=your-password \
  -v /path/to/betterdb-license.jwt:/run/secrets/betterdb-license.jwt:ro \
  -e BETTERDB_OFFLINE_LICENSE_FILE=/run/secrets/betterdb-license.jwt \
  -v betterdb-data:/app/data \
  -e STORAGE_TYPE=memory \
  betterdb/monitor
```

**Note**: `STORAGE_TYPE=memory` loses users and sessions on every restart, so the instance returns to the register screen and the next visitor claims the owner account. Use `sqlite` or `postgres` once other people can reach it.

No `BETTERDB_LICENSE_KEY` is set, so the monitor runs **fully offline** — no
outbound requests, telemetry disabled. Verify with
`curl -b cookies.txt http://localhost:3001/api/license/status`
(`source: offline-token`, `mode: offline`, `airGapped: true`); see
[Authenticating API Requests](#authenticating-api-requests) for the cookie.

### Accessing the Application

Once running, access the web interface at:

- **Web UI**: `http://localhost:3001` (or your custom port)
- **Health Check**: `http://localhost:3001/api/health`
- **Prometheus Metrics**: `http://localhost:3001/api/prometheus/metrics`

## HTTP Endpoints

| Endpoint                  | Description                   |
| ------------------------- | ----------------------------- |
| `/`                       | Web UI dashboard              |
| `/health`                 | Health check endpoint         |
| `/api`                    | Swagger/OpenAPI documentation |
| `/api/prometheus/metrics` | Prometheus metrics endpoint   |

All API endpoints are prefixed with `/api` when accessed through the web server.

### Authenticating API Requests

With user control enabled (the default on self-hosted installs), every API endpoint below
requires a signed-in session; without one the API answers `401`. The `curl` examples
throughout the docs assume a session cookie obtained once:

```bash
# Sign in and store the session cookie
curl -c cookies.txt -X POST http://localhost:3001/api/auth/sign-in/email \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "your-password"}'

# Reuse it on every later call
curl -b cookies.txt http://localhost:3001/api/connections
```

These routes stay open without a session: `/api/health`, `/api/version`,
`/api/system/workspace`, `/api/prometheus/metrics`, `/api/docs`, the `/api/auth` and
`/api/invite` routes, and reads under `/api/mcp`. Writes under `/api/mcp` that apply
changes — approving or rejecting cache and memory proposals — need a session too.

Set `WORKSPACE_DISABLED=true` to run without user control, in which case every endpoint
is reachable without signing in.

Sessions are cached in a signed cookie for 30 seconds, so a role change or a removed
member takes effect within that window rather than on the next request.

### Health

| Endpoint  | Method | Description                                                    |
| --------- | ------ | -------------------------------------------------------------- |
| `/health` | GET    | Health status of API server, Valkey/Redis, and storage backend |

### Version

| Endpoint   | Method | Description                                          |
| ---------- | ------ | ---------------------------------------------------- |
| `/version` | GET    | Current and latest version info, update availability |

### Settings

| Endpoint          | Method | Description                                           |
| ----------------- | ------ | ----------------------------------------------------- |
| `/settings`       | GET    | Get current application settings                      |
| `/settings`       | PUT    | Update application settings                           |
| `/settings/reset` | POST   | Reset settings to defaults from environment variables |

### Audit Trail

| Endpoint             | Method | Description                                     |
| -------------------- | ------ | ----------------------------------------------- |
| `/audit/entries`     | GET    | Get ACL audit log entries with optional filters |
| `/audit/stats`       | GET    | Get aggregated audit statistics                 |
| `/audit/failed-auth` | GET    | Get failed authentication attempts              |
| `/audit/by-user`     | GET    | Get audit entries for a specific username       |

### Client Analytics

| Endpoint                                 | Method | Description                                    |
| ---------------------------------------- | ------ | ---------------------------------------------- |
| `/client-analytics/snapshots`            | GET    | Get historical client connection snapshots     |
| `/client-analytics/timeseries`           | GET    | Get aggregated client counts over time         |
| `/client-analytics/stats`                | GET    | Get client analytics statistics                |
| `/client-analytics/history`              | GET    | Get connection history for specific client     |
| `/client-analytics/cleanup`              | DELETE | Manually trigger cleanup of old data           |
| `/client-analytics/command-distribution` | GET    | Get command frequency distribution by client   |
| `/client-analytics/idle-connections`     | GET    | Identify connections idle for extended periods |
| `/client-analytics/buffer-anomalies`     | GET    | Detect clients with unusual buffer sizes       |
| `/client-analytics/activity-timeline`    | GET    | Get activity over time for correlation         |
| `/client-analytics/spike-detection`      | GET    | Automatically detect unusual activity spikes   |

### Metrics

| Endpoint                              | Method | Description                               |
| ------------------------------------- | ------ | ----------------------------------------- |
| `/metrics/info`                       | GET    | Parsed INFO command output                |
| `/metrics/slowlog`                    | GET    | Slowlog entries                           |
| `/metrics/slowlog/length`             | GET    | Current slowlog length                    |
| `/metrics/slowlog`                    | DELETE | Reset slowlog                             |
| `/metrics/slowlog/patterns`           | GET    | Aggregated slowlog pattern analysis       |
| `/metrics/commandlog`                 | GET    | Commandlog entries (Valkey 8.1+)          |
| `/metrics/commandlog/length`          | GET    | Commandlog length (Valkey 8.1+)           |
| `/metrics/commandlog`                 | DELETE | Reset commandlog (Valkey 8.1+)            |
| `/metrics/commandlog/patterns`        | GET    | Commandlog pattern analysis (Valkey 8.1+) |
| `/metrics/latency/latest`             | GET    | Latest latency monitoring events          |
| `/metrics/latency/history/:eventName` | GET    | Latency history for specific event        |
| `/metrics/latency/histogram`          | GET    | Latency histogram for commands            |
| `/metrics/latency/doctor`             | GET    | Automated latency analysis report         |
| `/metrics/latency`                    | DELETE | Reset latency monitoring data             |
| `/metrics/memory/stats`               | GET    | Detailed memory usage statistics          |
| `/metrics/memory/doctor`              | GET    | Automated memory analysis report          |
| `/metrics/clients`                    | GET    | List of currently connected clients       |
| `/metrics/clients/:id`                | GET    | Information about specific client         |
| `/metrics/clients`                    | DELETE | Terminate client connections              |
| `/metrics/acl/log`                    | GET    | ACL security log entries                  |
| `/metrics/acl/log`                    | DELETE | Clear ACL log                             |
| `/metrics/role`                       | GET    | Replication role and status               |
| `/metrics/cluster/info`               | GET    | Cluster information and status            |
| `/metrics/cluster/nodes`              | GET    | Information about all cluster nodes       |
| `/metrics/cluster/slot-stats`         | GET    | Per-slot statistics (Valkey 8.0+)         |
| `/metrics/config`                     | GET    | Configuration values matching pattern     |
| `/metrics/config/:parameter`          | GET    | Value of specific config parameter        |
| `/metrics/dbsize`                     | GET    | Number of keys in current database        |
| `/metrics/lastsave`                   | GET    | Unix timestamp of last RDB save           |

### Prometheus

| Endpoint                  | Method | Description                               |
| ------------------------- | ------ | ----------------------------------------- |
| `/api/prometheus/metrics` | GET    | Prometheus-formatted metrics for scraping |

## Runtime Settings

The following settings can be modified at runtime via the `/settings` API endpoint without requiring an application restart:

| Setting                         | Default   | Description                                              |
| ------------------------------- | --------- | -------------------------------------------------------- |
| `auditPollIntervalMs`           | `60000`   | ACL audit log polling interval (milliseconds)            |
| `clientAnalyticsPollIntervalMs` | `60000`   | Client analytics data collection interval (milliseconds) |
| `anomalyPollIntervalMs`         | `1000`    | Anomaly detection polling interval (milliseconds)        |
| `anomalyCacheTtlMs`             | `3600000` | Anomaly detection cache TTL (milliseconds)               |
| `anomalyPrometheusIntervalMs`   | `30000`   | Prometheus summary update interval (milliseconds)        |

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
