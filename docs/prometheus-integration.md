# Prometheus Integration

BetterDB exports metrics at `/api/prometheus/metrics`.

## Anomaly Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `betterdb_anomaly_events_total` | Counter | severity, metric_type, anomaly_type |
| `betterdb_anomaly_events_current` | Gauge | severity |
| `betterdb_anomaly_by_severity` | Gauge | severity |
| `betterdb_anomaly_by_metric` | Gauge | metric_type |
| `betterdb_correlated_groups_total` | Counter | pattern, severity |
| `betterdb_correlated_groups_by_pattern` | Gauge | pattern |
| `betterdb_anomaly_buffer_ready` | Gauge | metric_type |
| `betterdb_anomaly_buffer_mean` | Gauge | metric_type |
| `betterdb_anomaly_buffer_stddev` | Gauge | metric_type |

## Scrape Config

```yaml
scrape_configs:
  - job_name: 'betterdb'
    static_configs:
      - targets: ['localhost:3001']
    metrics_path: '/api/prometheus/metrics'
    scrape_interval: 15s
```

## Useful Queries

```promql
# Anomaly rate
rate(betterdb_anomaly_events_total[5m])

# Critical anomalies in last hour
betterdb_anomaly_by_severity{severity="critical"}

# Detection system readiness
sum(betterdb_anomaly_buffer_ready) / count(betterdb_anomaly_buffer_ready) * 100

# Memory pressure incidents
increase(betterdb_correlated_groups_total{pattern="memory_pressure"}[1h])
```

## Alert Rules

See `docs/alertmanager-rules.yml` for ready-to-use Alertmanager rules.

## Configuration

The summary update interval can be configured via `ANOMALY_PROMETHEUS_INTERVAL_MS` (default: 30000ms).
