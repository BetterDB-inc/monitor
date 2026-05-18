---
title: AWS MemoryDB
parent: Provider Guides
nav_order: 3
---

# Connecting BetterDB to AWS MemoryDB

MemoryDB is a durable, Redis-compatible in-memory database. Like ElastiCache, it is VPC-only with no public endpoint. BetterDB connects via the **BetterDB Agent** running on an EC2 instance inside the same VPC.

TLS and authentication are **always required** on MemoryDB - there is no option to disable them.

## How It Works

```
Your App → MemoryDB cluster (VPC)
                  ↑
           BetterDB Agent (EC2, same VPC)
                  ↓ WSS :443
           BetterDB Cloud
```

## Prerequisites

- An AWS account with a MemoryDB cluster
- Ability to launch an EC2 instance in the same VPC as the cluster
- A BetterDB Cloud workspace with an agent token (see [Agent Connection](../agent-connection))

## Step 1 - Security Group Setup

**On the EC2 security group (create one if needed):**

| Direction | Protocol | Port | Destination |
|-----------|----------|------|-------------|
| Outbound | TCP | 443 | `0.0.0.0/0` (BetterDB Cloud) |
| Outbound | TCP | 6379 | MemoryDB security group |

**On the MemoryDB security group:**

| Direction | Protocol | Port | Source |
|-----------|----------|------|--------|
| Inbound | TCP | 6379 | EC2 security group |

## Step 2 - Launch an EC2 Instance

A `t3.micro` is sufficient for the agent.

1. Go to **EC2 > Launch Instance** in the AWS Console
2. Choose **Amazon Linux 2023** (recommended) or Ubuntu 22.04
3. Select `t3.micro`
4. Place it in the **same VPC and subnet** as your MemoryDB cluster
5. Assign the EC2 security group from Step 1
6. Add a key pair so you can SSH in
7. Launch the instance

## Step 3 - Install Docker on EC2

SSH into the instance, then:

**Amazon Linux 2023:**
```bash
sudo dnf install -y docker
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user
# Log out and back in for the group change to take effect
```

**Ubuntu 22.04:**
```bash
sudo apt-get update && sudo apt-get install -y docker.io
sudo systemctl enable --now docker
sudo usermod -aG docker ubuntu
# Log out and back in for the group change to take effect
```

Verify Docker is running:
```bash
docker run --rm hello-world
```

## Step 4 - Find Your MemoryDB Endpoint and Credentials

**Cluster endpoint:**

1. Go to **MemoryDB > Clusters** in the AWS Console
2. Select your cluster
3. Copy the **Cluster endpoint** - it looks like:
   ```
   clustercfg.my-cluster.abc123.memorydb.us-east-1.amazonaws.com
   ```

Always use the **Cluster endpoint** - it handles routing across shards automatically. Do not use individual node endpoints.

**User credentials:**

MemoryDB uses ACL users for authentication. To find or create credentials:

1. Go to **MemoryDB > Users** (or **ACLs**)
2. Use an existing user or create a new one with at least read permissions
3. Note the **username** and **password**

> If your cluster was created with the `default` user only and no password set, check the cluster's **Access control** settings in the console.

## Step 5 - Run the BetterDB Agent

Generate a token in BetterDB Cloud (**connection selector > Via Agent tab > Generate Token**), then run the agent on your EC2 instance:

```bash
docker run -d --name betterdb-agent \
  --restart=always \
  -e BETTERDB_TOKEN="<your-token>" \
  -e BETTERDB_CLOUD_URL="wss://<your-workspace>.app.betterdb.com/agent/ws" \
  -e VALKEY_HOST="clustercfg.my-cluster.abc123.memorydb.us-east-1.amazonaws.com" \
  -e VALKEY_PORT="6379" \
  -e VALKEY_USERNAME="<your-memorydb-username>" \
  -e VALKEY_PASSWORD="<your-memorydb-password>" \
  -e VALKEY_TLS="true" \
  betterdb/agent
```

TLS (`VALKEY_TLS=true`) and credentials are always required on MemoryDB.

## Step 6 - Verify the Connection

Check the agent logs:
```bash
docker logs -f betterdb-agent
```

A successful connection looks like:
```
BetterDB Agent v0.1.0
Connecting to valkey://clustercfg.my-cluster.abc123.memorydb.us-east-1.amazonaws.com:6379
[Agent] Connected to Valkey/Redis
[Agent] Detected redis 7.1.0
[Agent] Connecting to cloud: wss://myworkspace.app.betterdb.com/agent/ws
[Agent] WebSocket connected, sending hello
```

In BetterDB Cloud, the connection appears in the **Via Agent** tab with a **Connected** status.

## What Works on MemoryDB

| Feature | Status | Notes |
|---------|--------|-------|
| Memory & CPU metrics | ✅ | Via `INFO` |
| Key count, ops/sec, hit rate | ✅ | Via `INFO` |
| Slowlog | ✅ | Available on all clusters |
| Key analytics (SCAN) | ✅ | SCAN is supported |
| Anomaly detection | ✅ | Based on INFO polling |
| Webhooks & alerts | ✅ | |
| Migration (source or target) | ✅ | All data types supported |
| ACL audit trail | ✅ | MemoryDB has full ACL support |
| Client analytics | ⚠️ | `CLIENT LIST` returns limited data |
| CONFIG inspection | ❌ | `CONFIG GET/SET` is blocked by AWS |
| MONITOR | ❌ | Blocked by AWS |
| COMMANDLOG | ❌ | Valkey-only feature; not available on MemoryDB |

*Feature availability on managed providers changes frequently. Always consult the [AWS MemoryDB documentation](https://docs.aws.amazon.com/memorydb/) for the most up-to-date information on supported commands.*

## Known Limitations

**Cluster mode is always on.** MemoryDB always runs in cluster mode. BetterDB handles this automatically via the agent - always use the **Cluster endpoint**, not individual shard or node endpoints.

**TLS and auth are mandatory.** There is no way to connect to MemoryDB without TLS and credentials. Ensure `VALKEY_TLS=true` and valid credentials are always set on the agent.

**No CONFIG access.** AWS blocks `CONFIG GET` and `CONFIG SET`. The configuration panel in BetterDB will be unavailable.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `connect ETIMEDOUT` to MemoryDB | Security group misconfigured | Confirm the EC2 SG has outbound TCP 6379 to the MemoryDB SG, and the MemoryDB SG allows inbound from the EC2 SG |
| `connect ETIMEDOUT` to BetterDB Cloud | EC2 outbound 443 blocked | Check the EC2 SG has outbound TCP 443 to `0.0.0.0/0`, and the VPC route table has an internet gateway |
| `WRONGPASS` / `NOAUTH` | Wrong credentials | Check username and password against **MemoryDB > Users** in the console |
| `SSL routines` / TLS error | TLS not set | Ensure `-e VALKEY_TLS=true` is set - TLS is mandatory on MemoryDB |
| `MOVED` errors in logs | Wrong endpoint type | Use the **Cluster endpoint** (`clustercfg.*`), not a node or shard endpoint |
| `ERR unknown command 'CONFIG'` | AWS blocks CONFIG | Expected - BetterDB handles this automatically |
