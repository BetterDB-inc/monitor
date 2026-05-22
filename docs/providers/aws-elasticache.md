---
title: AWS ElastiCache
parent: Provider Guides
nav_order: 2
---

# Connecting BetterDB to AWS ElastiCache

ElastiCache is VPC-only - it has no public endpoint. BetterDB connects to it via the **BetterDB Agent**, a lightweight Docker container you run on an EC2 instance inside the same VPC.

## How It Works

```
Your App → ElastiCache (VPC)
                ↑
         BetterDB Agent (EC2, same VPC)
                ↓ WSS :443
         BetterDB Cloud
```

The agent connects outbound to BetterDB Cloud over port 443 - no inbound ports need to be opened on your firewall.

## Prerequisites

- An AWS account with an ElastiCache cluster (Redis or Valkey)
- Ability to launch an EC2 instance in the same VPC as the cluster
- A BetterDB Cloud workspace with an agent token (see [Agent Connection](../agent-connection))

## Step 1 - Security Group Setup

You need two security group rules before launching anything.

**On the EC2 security group (create one if needed):**

| Direction | Protocol | Port | Destination |
|-----------|----------|------|-------------|
| Outbound | TCP | 443 | `0.0.0.0/0` (BetterDB Cloud) |
| Outbound | TCP | 6379 | ElastiCache security group |

**On the ElastiCache security group:**

| Direction | Protocol | Port | Source |
|-----------|----------|------|--------|
| Inbound | TCP | 6379 | EC2 security group |

> If your cluster uses a non-default port, substitute 6379 with your actual port in both rules.

## Step 2 - Launch an EC2 Instance

A `t3.micro` is sufficient - the agent is very lightweight.

1. Go to **EC2 > Launch Instance** in the AWS Console
2. Choose **Amazon Linux 2023** (recommended) or Ubuntu 22.04
3. Select `t3.micro` (or larger if co-locating with other workloads)
4. Place it in the **same VPC and subnet** as your ElastiCache cluster
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

## Step 4 - Find Your ElastiCache Endpoint

In the AWS Console, go to **ElastiCache > Clusters** and select your cluster.

| Cluster type | Endpoint to use |
|---|---|
| **Serverless** | The endpoint shown on the cluster overview page |
| **Cluster mode disabled** | **Primary endpoint** (read/write) |
| **Cluster mode enabled** | **Configuration endpoint** |

The endpoint looks like:
```
my-cluster.abc123.0001.use1.cache.amazonaws.com        # standalone
clustercfg.my-cluster.abc123.use1.cache.amazonaws.com  # cluster mode
my-cluster.serverless.use1.cache.amazonaws.com          # serverless
```

## Authentication options

BetterDB supports two ways for the agent to authenticate against ElastiCache. Pick one before continuing.

| Mode | When to pick | Requires |
|------|--------------|----------|
| **Password** | Cluster uses an AUTH token, or you do not want to use IAM | An auth token configured on the cluster |
| **IAM** (recommended for Valkey 7.2+ / Redis 7.0+) | You want short-lived rotating credentials, audit via CloudTrail, and no static secrets | TLS enabled on the cluster, an IAM-mode user, and an EC2 instance role with `elasticache:Connect` |

If you pick IAM, complete [Step 5a: configure IAM authentication](#step-5a---configure-iam-authentication-iam-only) before running the agent. If you pick password, skip directly to [Step 6](#step-6---run-the-betterdb-agent).

## Step 5a - Configure IAM authentication (IAM only)

This step sets up the AWS-side resources required for IAM-based authentication. Skip if you are using password authentication.

Three things have to be in place:

1. **An ElastiCache IAM user.** The user-id must equal the user-name; this is an AWS requirement for IAM-mode users.

   ```bash
   aws elasticache create-user \
     --user-id <your-iam-user-id> \
     --user-name <your-iam-user-id> \
     --engine valkey \
     --access-string "on ~* +@all" \
     --authentication-mode Type=iam
   ```

   For Redis-engine clusters, change `--engine valkey` to `--engine redis`.

2. **A user group containing the IAM user.** For Valkey-engine clusters, the user group must also include a Valkey-engine user named `default`. The AWS-provided `default` user is Redis-engine and AWS rejects mixing engines in a user group.

   ```bash
   # Only needed for Valkey clusters - create a disabled placeholder
   # named "default" so the user group has a default user
   aws elasticache create-user \
     --user-id valkey-default \
     --user-name default \
     --engine valkey \
     --access-string "off" \
     --authentication-mode Type=password --passwords "$(openssl rand -hex 24)Aa1!"

   # Then create the user group
   aws elasticache create-user-group \
     --user-group-id <your-user-group-id> \
     --engine valkey \
     --user-ids valkey-default <your-iam-user-id>
   ```

   Attach the user group to the cluster (set it during cluster creation, or use `aws elasticache modify-replication-group --user-group-ids-to-add` for existing clusters).

3. **An IAM policy on the EC2 instance role granting `elasticache:Connect`.**

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": "elasticache:Connect",
       "Resource": [
         "arn:aws:elasticache:<region>:<account-id>:replicationgroup:<your-cache-name>",
         "arn:aws:elasticache:<region>:<account-id>:user:<your-iam-user-id>"
       ]
     }]
   }
   ```

   Attach this policy to the IAM role used by your EC2 instance profile. The agent reads credentials from the instance metadata service.

> The cluster must have encryption in transit (TLS) enabled. IAM authentication will not work on a cluster without TLS, and the agent enforces this at startup.

## Step 6 - Run the BetterDB Agent

Generate a token in BetterDB Cloud (**connection selector > Via Agent tab > Generate Token**), then run the agent on your EC2 instance.

### Password authentication

**Without auth (no auth token configured on the cluster):**
```bash
docker run -d --name betterdb-agent \
  --restart=always \
  -e BETTERDB_TOKEN="<your-token>" \
  -e BETTERDB_CLOUD_URL="wss://<your-workspace>.app.betterdb.com/agent/ws" \
  -e VALKEY_HOST="<your-elasticache-endpoint>" \
  -e VALKEY_PORT="6379" \
  betterdb/agent
```

**With auth token and TLS (ElastiCache Serverless or encryption enabled):**
```bash
docker run -d --name betterdb-agent \
  --restart=always \
  -e BETTERDB_TOKEN="<your-token>" \
  -e BETTERDB_CLOUD_URL="wss://<your-workspace>.app.betterdb.com/agent/ws" \
  -e VALKEY_HOST="<your-elasticache-endpoint>" \
  -e VALKEY_PORT="6379" \
  -e VALKEY_PASSWORD="<your-auth-token>" \
  -e VALKEY_TLS="true" \
  betterdb/agent
```

### IAM authentication

```bash
docker run -d --name betterdb-agent \
  --restart=always \
  -e BETTERDB_TOKEN="<your-token>" \
  -e BETTERDB_CLOUD_URL="wss://<your-workspace>.app.betterdb.com/agent/ws" \
  -e VALKEY_HOST="<your-elasticache-endpoint>" \
  -e VALKEY_PORT="6379" \
  -e VALKEY_USERNAME="<your-iam-user-id>" \
  -e VALKEY_TLS="true" \
  -e AGENT_AUTH_MODE="elasticache-iam" \
  -e AWS_REGION="us-east-1" \
  -e AWS_RESOURCE_NAME="<your-cache-name>" \
  -e AWS_USER_ID="<your-iam-user-id>" \
  betterdb/agent
```

For ElastiCache Serverless, also set `-e AWS_SERVERLESS="true"`.

When running on EC2 with an instance profile attached, no AWS credential env vars are needed - the agent reads credentials from the instance metadata service. If running outside EC2, supply `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` env vars on the container.

> ElastiCache Serverless always requires TLS. For self-designed clusters, TLS is enabled if you checked **Encryption in transit** when creating the cluster.

## Step 7 - Verify the Connection

Check the agent logs:
```bash
docker logs -f betterdb-agent
```

A successful connection looks like:
```
BetterDB Agent v0.1.0
Connecting to valkey://my-cluster.abc123.use1.cache.amazonaws.com:6379
[Agent] Connected to Valkey/Redis
[Agent] Detected redis 7.1.0
[Agent] Connecting to cloud: wss://myworkspace.app.betterdb.com/agent/ws
[Agent] WebSocket connected, sending hello
```

In BetterDB Cloud, the connection appears in the **Via Agent** tab with a **Connected** status within a few seconds.

## What Works on ElastiCache

| Feature | Status | Notes |
|---------|--------|-------|
| Memory & CPU metrics | ✅ | Via `INFO` |
| Key count, ops/sec, hit rate | ✅ | Via `INFO` |
| Slowlog | ✅ | Available on all cluster types |
| Key analytics (SCAN) | ✅ | SCAN is supported |
| Anomaly detection | ✅ | Based on INFO polling |
| Webhooks & alerts | ✅ | |
| Migration (source or target) | ✅ | All data types supported |
| Client analytics | ⚠️ | `CLIENT LIST` is restricted - returns limited data |
| ACL audit trail | ⚠️ | Available on Redis 6+ / Valkey clusters with ACL enabled |
| CONFIG inspection | ❌ | `CONFIG GET/SET` is blocked by AWS |
| MONITOR | ❌ | Blocked by AWS |
| COMMANDLOG | ❌ | Valkey-only feature; not available on ElastiCache Redis |

*Feature availability on managed providers changes frequently. Always consult the [AWS ElastiCache documentation](https://docs.aws.amazon.com/elasticache/) for the most up-to-date information on supported commands.*

## Known Limitations

**No CONFIG access.** AWS blocks `CONFIG GET` and `CONFIG SET` on all ElastiCache clusters. The configuration panel in BetterDB will be unavailable.

**Cluster mode endpoint matters.** For cluster mode enabled clusters, always use the **Configuration endpoint** - not an individual node endpoint. Using a node endpoint will only give BetterDB visibility into a single shard.

**Serverless scales to zero.** ElastiCache Serverless suspends clusters after a period of inactivity. The first connection after suspension may take a few seconds - the agent handles this automatically with reconnect backoff.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `connect ETIMEDOUT` to ElastiCache | Security group misconfigured | Confirm the EC2 SG has outbound TCP 6379 to the ElastiCache SG, and the ElastiCache SG allows inbound from the EC2 SG |
| `connect ETIMEDOUT` to BetterDB Cloud | EC2 outbound 443 blocked | Check the EC2 SG has outbound TCP 443 to `0.0.0.0/0`, and the VPC route table has an internet gateway |
| `WRONGPASS` / `NOAUTH` | Auth token mismatch | Set `VALKEY_PASSWORD` to the **Auth token** configured on the cluster (not an IAM credential) |
| `SSL routines` / TLS error | TLS mismatch | Add `-e VALKEY_TLS=true` if the cluster has encryption in transit enabled; remove it if not |
| Agent connects but dashboard shows no data | Wrong endpoint type | For cluster mode enabled, use the **Configuration endpoint**, not a node or primary endpoint |
| `WRONGPASS` in IAM mode immediately after policy attach | IAM policy propagation lag (~30-60s) | Wait one minute; the agent retries automatically on reconnect |
| `WRONGPASS` persists in IAM mode | User-id != user-name, or user not in the cluster's user group | Verify with `aws elasticache describe-users` and `aws elasticache describe-user-groups` |
| `NOAUTH` in IAM mode | TLS disabled on the cluster | IAM auth requires `transit-encryption-enabled` on the replication group; recreate or modify the cluster with TLS |
| `Could not load credentials` at agent startup in IAM mode | No AWS credentials reachable from the agent process | Attach an EC2 instance profile, or pass `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` env vars to the container |
| `ERR unknown command 'CONFIG'` | AWS blocks CONFIG | Expected - BetterDB handles this automatically |
