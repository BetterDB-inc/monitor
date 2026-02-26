---
title: Agent Connection
layout: default
---

# Connecting via the BetterDB Agent

## Quick Start

```bash
# 1. Generate a token in the BetterDB Cloud UI (Via Agent tab)

# 2. Run the agent
docker run -d --name betterdb-agent \
  --restart=always \
  -e BETTERDB_TOKEN="<your-token>" \
  -e BETTERDB_CLOUD_URL="wss://<your-workspace>.app.betterdb.com/agent/ws" \
  -e VALKEY_HOST="<your-valkey-host>" \
  -e VALKEY_PORT="6379" \
  betterdb/agent

# 3. Check logs
docker logs -f betterdb-agent
```

---

## What is the BetterDB Agent?

The BetterDB Agent is a lightweight process that runs alongside your Valkey or Redis instance. It connects **outbound** to BetterDB Cloud via WebSocket, so your database is never exposed to the internet. The agent relays monitoring commands and metrics between BetterDB Cloud and your instance.

## Prerequisites

- A BetterDB Cloud account with a workspace
- Network access from the agent to your Valkey/Redis instance (default port 6379)
- Outbound internet access from the agent (HTTPS/WSS on port 443)
- Docker installed (recommended) or Node.js 20+

## Generate an Agent Token

1. Log in to your BetterDB Cloud workspace
2. Navigate to the **Via Agent** tab in the connection selector
3. Click **Generate Token**
4. Give it a descriptive name (e.g. `production-valkey`, `staging-redis`)
5. Copy the token — it will not be shown again

Tokens can be revoked at any time from the same UI.

## Run the Agent

### Docker (recommended)

```bash
docker run -d --name betterdb-agent \
  --restart=always \
  -e BETTERDB_TOKEN="<your-token>" \
  -e BETTERDB_CLOUD_URL="wss://<your-workspace>.app.betterdb.com/agent/ws" \
  -e VALKEY_HOST="<your-valkey-host>" \
  -e VALKEY_PORT="6379" \
  betterdb/agent
```

### With authentication

```bash
docker run -d --name betterdb-agent \
  --restart=always \
  -e BETTERDB_TOKEN="<your-token>" \
  -e BETTERDB_CLOUD_URL="wss://<your-workspace>.app.betterdb.com/agent/ws" \
  -e VALKEY_HOST="<your-valkey-host>" \
  -e VALKEY_PORT="6379" \
  -e VALKEY_USERNAME="myuser" \
  -e VALKEY_PASSWORD="mypassword" \
  betterdb/agent
```

### With TLS (required for AWS ElastiCache Serverless)

```bash
docker run -d --name betterdb-agent \
  --restart=always \
  -e BETTERDB_TOKEN="<your-token>" \
  -e BETTERDB_CLOUD_URL="wss://<your-workspace>.app.betterdb.com/agent/ws" \
  -e VALKEY_HOST="my-cluster.serverless.use1.cache.amazonaws.com" \
  -e VALKEY_PORT="6379" \
  -e VALKEY_TLS="true" \
  betterdb/agent
```

### Without Docker (Node.js)

Requires Node.js 20+.

```bash
npx betterdb-agent \
  --token "<your-token>" \
  --cloud-url "wss://<your-workspace>.app.betterdb.com/agent/ws" \
  --valkey-host "<your-valkey-host>" \
  --valkey-port 6379
```

With all options:

```bash
npx betterdb-agent \
  --token "<your-token>" \
  --cloud-url "wss://<your-workspace>.app.betterdb.com/agent/ws" \
  --valkey-host "<your-valkey-host>" \
  --valkey-port 6379 \
  --valkey-username myuser \
  --valkey-password mypassword \
  --valkey-tls true
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BETTERDB_TOKEN` | *(required)* | Agent token from the BetterDB Cloud UI |
| `BETTERDB_CLOUD_URL` | *(required)* | WebSocket URL: `wss://<workspace>.app.betterdb.com/agent/ws` |
| `VALKEY_HOST` | `localhost` | Hostname of your Valkey/Redis instance |
| `VALKEY_PORT` | `6379` | Port of your Valkey/Redis instance |
| `VALKEY_PASSWORD` | *(none)* | Password if authentication is required |
| `VALKEY_USERNAME` | `default` | ACL username (Valkey 7.2+ / Redis 6+) |
| `VALKEY_TLS` | `false` | Set to `true` for TLS connections |
| `VALKEY_DB` | `0` | Database number to connect to |

## Verify the Connection

Check the agent logs:

```bash
docker logs -f betterdb-agent
```

A successful connection looks like:

```
BetterDB Agent v0.1.0
Connecting to valkey://my-host:6379
[Agent] Connected to Valkey/Redis
[Agent] Detected valkey 8.1
[Agent] Connecting to cloud: wss://myworkspace.app.betterdb.com/agent/ws
[Agent] WebSocket connected, sending hello
```

In the BetterDB Cloud UI, the agent connection appears in the **Via Agent** tab with a **Connected** status. The dashboard begins populating with metrics within a few seconds.

## Managed Services (AWS ElastiCache, etc.)

Managed Valkey/Redis services like AWS ElastiCache Serverless restrict certain administrative commands (`SLOWLOG`, `CONFIG`, `CLIENT LIST`, `ACL LOG`). BetterDB handles this automatically:

- The `INFO` command works on all managed services and provides core metrics: memory, CPU, connections, ops/sec, keyspace, and replication status
- Features that depend on restricted commands are greyed out in the dashboard with an explanation of why they are unavailable
- No action needed from the user — the agent and dashboard adapt automatically

### AWS ElastiCache

- Set `VALKEY_TLS=true` (encryption in transit is enabled by default on ElastiCache Serverless)
- The agent must run **inside the same VPC** as the ElastiCache instance (e.g. on an EC2 instance or EKS pod)
- Ensure the ElastiCache security group allows inbound TCP 6379 from the agent's security group

### Other Managed Services

The same approach works with Google Cloud Memorystore, Azure Cache for Redis, Aiven, and other managed providers. Set `VALKEY_TLS=true` if the provider requires encrypted connections.

## Networking & Security

- The agent initiates **all connections outbound** — no inbound ports need to be opened on your firewall
- The WebSocket connection uses WSS (TLS-encrypted) on port 443
- The agent authenticates to BetterDB Cloud using the token (JWT)
- If the WebSocket connection drops, the agent reconnects automatically with exponential backoff (1s, 2s, 4s, ... up to 30s max)
- If the Valkey/Redis connection drops, the agent retries with linear backoff (capped at 30s)
- Revoking a token from the UI immediately disconnects the agent

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `WS error: Unexpected server response: 401` | Invalid or revoked token | Generate a new token from the UI |
| `connect ETIMEDOUT` to Valkey/Redis | Agent can't reach the database | Check host, port, and security groups. Ensure the agent is in the same network as the database |
| `connect ETIMEDOUT` to cloud | Agent can't reach the internet | Check outbound access on port 443. Ensure DNS resolves `app.betterdb.com` |
| `Pong timeout, closing connection` | WebSocket keepalive failed | Check network stability between the agent and the internet. The agent will auto-reconnect |
| `Valkey error: NOAUTH` | Database requires authentication | Set `VALKEY_PASSWORD` (and `VALKEY_USERNAME` if using ACL) |
| `Valkey error: WRONGPASS` | Incorrect credentials | Verify `VALKEY_USERNAME` and `VALKEY_PASSWORD` |
| Dashboard shows "Disconnected" | WebSocket dropped | The agent auto-reconnects. Check agent logs for the underlying error |
| Some dashboard panels are greyed out | Managed service restricts the command | Expected behavior — see [Managed Services](#managed-services-aws-elasticache-etc) above |

### Viewing Logs

```bash
# Follow logs in real time
docker logs -f betterdb-agent

# Last 50 lines
docker logs --tail 50 betterdb-agent
```

### Restarting the Agent

```bash
docker restart betterdb-agent
```

### Updating the Agent

```bash
docker pull betterdb/agent
docker rm -f betterdb-agent
# Re-run the docker run command from above
```

```bash
# npm
npx betterdb-agent@latest --version
```
