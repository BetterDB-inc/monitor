---
title: Home
layout: home
nav_order: 1
---

# BetterDB Documentation

BetterDB is a Valkey-first monitoring and observability platform providing real-time dashboards, anomaly detection, and operational intelligence for your Valkey and Redis deployments.

## Quick Start

```bash
docker run -d \
  --name betterdb \
  -p 3001:3001 \
  -e DB_HOST=your-valkey-host \
  -e BETTERDB_LICENSE_KEY=your-license-key \
  betterdb/monitor
```

Open [http://localhost:3001](http://localhost:3001) to access the dashboard.

Running Kubernetes? Install with Helm instead:

```bash
helm repo add betterdb https://docs.betterdb.com/charts
helm install betterdb-monitor betterdb/betterdb-monitor \
  --namespace betterdb --create-namespace \
  --set db.host=my-valkey.default.svc.cluster.local
```

## Documentation

- [Configuration Reference](configuration) — Environment variables, Docker setup, and runtime settings
- [Kubernetes (Helm)](kubernetes) — Helm chart install, storage options, Secrets, and air-gapped licensing
- [Updating](updating) — How to upgrade to the latest version for each install method (Docker, CLI, Kubernetes)
- [Prometheus Metrics](prometheus-metrics) — Metrics reference, PromQL queries, and alerting rules
- [Anomaly Detection](anomaly-detection) — Understanding detection patterns and tuning sensitivity
- [Valkey Features](valkey-features) — Valkey-specific capabilities like COMMANDLOG and SLOT-STATS

## Provider Guides

Step-by-step connection guides for managed Redis/Valkey providers:

- [Upstash](providers/upstash) — Serverless Redis/Valkey, direct connection with TLS
- [Redis Cloud](providers/redis-cloud) — Managed Redis, direct connection via public endpoint
- [AWS ElastiCache](providers/aws-elasticache) — VPC-only, requires BetterDB Agent on EC2
- [AWS MemoryDB](providers/aws-memorydb) — VPC-only, requires BetterDB Agent on EC2

## API Reference

BetterDB includes interactive API documentation powered by Swagger/OpenAPI.

Once running, access it at: [http://localhost:3001/api](http://localhost:3001/api)

## Links

- [BetterDB Website](https://betterdb.com)
- [GitHub Repository](https://github.com/betterdb-inc/monitor)
- [Report an Issue](https://github.com/betterdb-inc/monitor/issues)
