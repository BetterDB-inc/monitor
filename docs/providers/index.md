---
title: Provider Guides
nav_order: 8
has_children: true
---

# Connecting to Managed Providers

BetterDB works with any Redis-compatible managed service. These guides cover provider-specific connection details, required settings, and known feature limitations for each platform.

| Provider | Protocol | TLS | Direct Connection |
|----------|----------|-----|-------------------|
| [Upstash](upstash) | Redis/Valkey | Required | ✅ Yes |

> If your provider runs on a non-standard port or inside a private VPC, use the [BetterDB Agent](../agent-connection) instead of a direct connection.
