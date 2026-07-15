---
title: Provider Guides
nav_order: 8
has_children: true
---

# Connecting to Managed Providers

BetterDB works with any Redis-compatible managed service. This index covers the providers we have first-class guides for, and the two connection methods BetterDB uses to reach them.

## Quick connect with a connection URL

The fastest way to connect: paste a full connection URL into the **Quick connect** box on the connect screen (or into the **Host** field of the Add Connection form - it expands into the individual fields automatically).

```
rediss://default:your-password@your-host.example.com:6379
```

Supported forms:

| Form | Meaning |
|------|---------|
| `redis://host:6379` | Plain connection, no TLS |
| `rediss://host:6379` | TLS enabled (note the double `s`) |
| `valkey://` / `valkeys://` | Same as above, Valkey-flavored |
| `redis://user:password@host:6379/2` | Credentials and database index `2` |
| `host:6379` | Bare host and port |

> HTTP REST endpoints (such as Upstash's `UPSTASH_REDIS_REST_URL`) will **not** work - BetterDB speaks the Redis wire protocol over TCP. Use the TCP endpoint and token instead.

## Connection methods

BetterDB connects to your database in one of two ways. Most providers support both; some only support one.

### Direct connection

BetterDB Cloud opens a TCP connection (with TLS) directly to your database's public endpoint. Best for managed providers that expose a public endpoint with TLS, like Upstash, Redis Cloud, and Aiven. Configure in the connection selector under **Direct** by entering the host, port, and credentials.

BetterDB Cloud allows outbound connections on ports **443**, **2000–2999**, and **6000–6999** (with a small number of sensitive infrastructure ports blocked). Any database on a port outside these ranges requires the agent.

### Via the BetterDB Agent

The [BetterDB Agent](../agent-connection) is a lightweight Docker container or npm package that runs inside your network. It connects outbound (port 443) to BetterDB Cloud over a WebSocket, then relays monitoring commands from BetterDB Cloud to your local database. The database never needs a public endpoint.

Required for:
- AWS ElastiCache (VPC-only)
- AWS MemoryDB (VPC-only)
- Google Cloud Memorystore (VPC-only)
- Azure Cache for Redis (VNet-only) if you use private endpoints
- Any self-hosted database not exposed to the internet
- Any database on a port other than 6379, 6380, or 443

The agent supports two authentication modes:
- **Password** - works against any Valkey/Redis instance with AUTH or ACL credentials.
- **AWS IAM** - SigV4-signed short-lived tokens for ElastiCache Valkey 7.2+ / Redis OSS 7.0+. No static passwords; credentials rotate automatically. See [AWS ElastiCache](aws-elasticache) for setup.

See the [Agent Connection guide](../agent-connection) for full configuration, environment variables, and troubleshooting.

## Provider matrix

| Provider | Protocol | TLS | Connection method | Auth modes |
|----------|----------|-----|-------------------|------------|
| [Upstash](upstash) | Redis/Valkey | Required | Direct | Password |
| [Redis Cloud](redis-cloud) | Redis | Optional (plan-dependent) | Direct | Password |
| [AWS ElastiCache](aws-elasticache) | Redis/Valkey | Optional (required on Serverless and for IAM auth) | Agent via EC2 | Password, IAM |
| [AWS MemoryDB](aws-memorydb) | Redis | Required | Agent via EC2 | Password |

> AWS services (ElastiCache, MemoryDB) are VPC-only and require the [BetterDB Agent](../agent-connection) running on an EC2 instance inside the same VPC. Upstash, Redis Cloud, and other providers with public endpoints support direct connection.
