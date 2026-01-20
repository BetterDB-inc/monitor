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

## Documentation

- [Configuration Reference](configuration) — Environment variables, Docker setup, and runtime settings
- [Prometheus Metrics](prometheus-metrics) — Metrics reference, PromQL queries, and alerting rules
- [Anomaly Detection](anomaly-detection) — Understanding detection patterns and tuning sensitivity
- [Valkey Features](valkey-features) — Valkey-specific capabilities like COMMANDLOG and SLOT-STATS

## Links

- [BetterDB Website](https://betterdb.com)
- [GitHub Repository](https://github.com/betterdb-inc/monitor)
- [Report an Issue](https://github.com/betterdb-inc/monitor/issues)
