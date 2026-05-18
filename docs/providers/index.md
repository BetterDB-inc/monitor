---
title: Provider Guides
nav_order: 8
has_children: true
---

# Connecting to Managed Providers

BetterDB works with any Redis-compatible managed service. These guides cover provider-specific connection details, required settings, and known feature limitations for each platform.

| Provider | Protocol | TLS | Connection method |
|----------|----------|-----|-------------------|
| [Upstash](upstash) | Redis/Valkey | Required | Direct |
| [AWS ElastiCache](aws-elasticache) | Redis/Valkey | Optional (required on Serverless) | Agent via EC2 |
| [AWS MemoryDB](aws-memorydb) | Redis | Required | Agent via EC2 |

> AWS services (ElastiCache, MemoryDB) are VPC-only and require the [BetterDB Agent](../agent-connection) running on an EC2 instance inside the same VPC. Upstash and other providers with public endpoints support direct connection.
