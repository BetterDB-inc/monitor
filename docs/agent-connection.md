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

## Authentication Modes

The agent supports two authentication modes when connecting to your Valkey or Redis instance.

### Password (default)

The agent connects with a static username and password supplied via `VALKEY_USERNAME` and `VALKEY_PASSWORD`. This works against any Valkey/Redis instance that uses AUTH or ACL-based password authentication, including self-hosted clusters, ElastiCache with auth tokens, Redis Cloud, Upstash, and most other managed providers.

No additional configuration is required - this is the default mode.

### AWS IAM (ElastiCache only)

For ElastiCache for Valkey 7.2+ or Redis OSS 7.0+, the agent can authenticate using short-lived SigV4-signed IAM tokens instead of a static password. Tokens are minted from the agent's local AWS credentials (instance profile, container role, or env vars) and rotated on every reconnect, so nothing sensitive needs to be configured on the agent or stored in BetterDB Cloud.

When to use IAM auth:
- You want to eliminate password rotation operationally.
- You require all data-plane access to be auditable via CloudTrail.
- You already manage authorization through IAM identities.

Prerequisites on the AWS side:
- The cluster runs ElastiCache for Valkey 7.2+ or Redis OSS 7.0+.
- The cluster has encryption in transit (TLS) enabled. IAM auth requires TLS.
- An ElastiCache user exists with `authentication-mode Type=iam`. The user-id must equal the user-name.
- The user is in a user group attached to the cluster. For Valkey-engine clusters, the user group must include a Valkey-engine user named `default` (the AWS-provided default user is Redis-engine and cannot be added to a Valkey user group).
- The agent runs with AWS credentials that have `elasticache:Connect` permission on the cluster ARN and the user ARN.

See [AWS ElastiCache](providers/aws-elasticache) for a complete walkthrough.

To enable IAM auth, set `AGENT_AUTH_MODE=elasticache-iam` plus the AWS-specific variables described in the next section. The agent fails fast at startup if any required variable is missing or if TLS is not enabled.

## When to Use the Agent vs Direct Connection

| Scenario | Recommended |
|----------|-------------|
| Database on port 6379 or 6380, publicly accessible | Direct connection |
| Database on a non-standard port | **Agent** |
| Database inside a private VPC (AWS, GCP, Azure) | **Agent** |
| AWS ElastiCache, GCP Memorystore (VPC-only) | **Agent** |
| Upstash, Redis Cloud, Aiven (public endpoint) | Direct connection |

> BetterDB Cloud workspaces allow outbound connections on ports **443**, **2000–2999**, and **6000–6999** (with a small number of sensitive infrastructure ports blocked). Any port outside these ranges requires the agent.

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
npx @betterdb/agent \
  --token "<your-token>" \
  --cloud-url "wss://<your-workspace>.app.betterdb.com/agent/ws" \
  --valkey-host "<your-valkey-host>" \
  --valkey-port 6379
```

With all options:

```bash
npx @betterdb/agent \
  --token "<your-token>" \
  --cloud-url "wss://<your-workspace>.app.betterdb.com/agent/ws" \
  --valkey-host "<your-valkey-host>" \
  --valkey-port 6379 \
  --valkey-username myuser \
  --valkey-password mypassword \
  --valkey-tls true
```

With AWS IAM authentication (ElastiCache only):

```bash
npx @betterdb/agent \
  --token "<your-token>" \
  --cloud-url "wss://<your-workspace>.app.betterdb.com/agent/ws" \
  --valkey-host "<your-elasticache-endpoint>" \
  --valkey-port 6379 \
  --valkey-username <your-iam-user-id> \
  --valkey-tls true \
  --auth-mode elasticache-iam \
  --aws-region us-east-1 \
  --aws-resource-name <your-cache-name> \
  --aws-user-id <your-iam-user-id>
```

AWS credentials are picked up from the standard chain in this order: environment variables (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`), shared config files (`~/.aws/credentials`), EC2 instance profile, and container role. On EC2, attach an instance profile with `elasticache:Connect` permission and the agent will discover credentials automatically.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BETTERDB_TOKEN` | *(required)* | Agent token from the BetterDB Cloud UI |
| `BETTERDB_CLOUD_URL` | *(required)* | WebSocket URL: `wss://<workspace>.app.betterdb.com/agent/ws` |
| `VALKEY_HOST` | `localhost` | Hostname of your Valkey/Redis instance |
| `VALKEY_PORT` | `6379` | Port of your Valkey/Redis instance |
| `VALKEY_USERNAME` | `default` | ACL username (Valkey 7.2+ / Redis 6+). For IAM auth, set to the ElastiCache IAM user-id |
| `VALKEY_PASSWORD` | *(none)* | Password (password mode only) |
| `VALKEY_TLS` | `false` | Set to `true` for TLS connections. **Required** when `AGENT_AUTH_MODE=elasticache-iam` |
| `VALKEY_DB` | `0` | Database number to connect to |
| `AGENT_AUTH_MODE` | `password` | Authentication mode: `password` or `elasticache-iam` |
| `AWS_REGION` | *(none)* | AWS region of the cluster. **Required** when `AGENT_AUTH_MODE=elasticache-iam` |
| `AWS_RESOURCE_NAME` | *(none)* | Cache name (replication group ID for standard, cache name for serverless). **Required** when `AGENT_AUTH_MODE=elasticache-iam` |
| `AWS_USER_ID` | *(none)* | ElastiCache IAM user-id. **Required** when `AGENT_AUTH_MODE=elasticache-iam` |
| `AWS_SERVERLESS` | `false` | Set to `true` if the cluster is ElastiCache Serverless |

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
| `WRONGPASS` immediately after enabling IAM mode | IAM policy not yet propagated | Wait 60s and let the agent's automatic reconnect re-attempt. The first authentication after a policy attach can fail; subsequent ones succeed |
| `WRONGPASS` consistently in IAM mode, no improvement | User-id does not equal user-name, or user is not in the cluster's user group | Verify with `aws elasticache describe-users` that the user-id equals the user-name and that the user appears in the user group attached to the cluster |
| `NOAUTH` in IAM mode | TLS is disabled | ElastiCache IAM auth requires TLS. Set `VALKEY_TLS=true` |
| `IAM reconnect failed` looping in agent logs | Token signing succeeded but server rejected it | Confirm the cluster is Valkey 7.2+ or Redis 7.0+, the user authentication mode is `iam`, and AWS credentials have `elasticache:Connect` on the cluster ARN |
| `Could not load credentials from any providers` | Agent process has no AWS credentials available | Attach an EC2 instance profile, set `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` env vars, or run on a host that exposes container credentials |
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
npx @betterdb/agent@latest --version
```
