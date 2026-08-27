---
title: OpenTelemetry
nav_order: 3.5
---

# OpenTelemetry (OTLP)

BetterDB Monitor speaks OTLP in both directions. It **ingests** traces from your instrumented applications, and it can **export** its metrics and events to any OTLP collector.

One thing to be clear about up front: Monitor's metrics are Prometheus-first (see **[Prometheus Integration](prometheus-integration.md)**). The OTLP metrics export is a mirror of that registry, not the source of truth. And on the trace side Monitor is a **receiver**: it stores spans your apps send, it does not emit spans of its own.

## At a glance

| Signal | Direction | Endpoint | Default |
|--------|-----------|----------|---------|
| Traces | Ingest (receive) | `POST /v1/traces` | on |
| Metrics | Export (mirror) | `${OTLP endpoint}/v1/metrics` | off, opt-in |
| Events | Export (logs) | `${OTLP endpoint}/v1/logs` | off, opt-in |

Both exports are off until you set `OTEL_EXPORTER_OTLP_ENDPOINT`. The collector handles fan-out to Jaeger, Tempo, Cloudwatch, or whatever backend you run.

## Trace ingestion

Monitor exposes a standard OTLP/HTTP trace receiver at **`/v1/traces`**. Note this path sits at the server root, not under the `/api` prefix.

It accepts both OTLP encodings:

- `application/x-protobuf` - the OTel SDK default (`OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`)
- `application/json` - set `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`

Ingested spans from `@betterdb/*` instrumentation scopes (plus their root spans) are kept and rendered as request waterfalls in the AI Traces view, correlated with the live Valkey state underneath each request.

Point your application's OTLP exporter at Monitor:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://monitor-host:3001
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf          # or http/json
# only if you set OTEL_INGEST_TOKEN on Monitor:
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>
```

**Auth.** If `OTEL_INGEST_TOKEN` is set, requests must carry `Authorization: Bearer <token>`. The token is required in cloud mode, where `/v1/traces` is allowlisted past session auth. Set `OTEL_INGEST_ENABLED=false` to turn the receiver off entirely.

## Metrics export

Set `OTEL_EXPORTER_OTLP_ENDPOINT` and Monitor mirrors its Prometheus registry to OTLP metrics, pushing to `${endpoint}/v1/metrics` on an interval as service `betterdb-monitor`.

A caveat worth knowing: counters and gauges are mirrored, but **histograms and summaries are skipped** because they do not map cleanly onto the OTLP instruments here. So the OTLP mirror is a subset. For the complete set, including histograms and every `betterdb_*` family, scrape the Prometheus endpoint at `/api/prometheus/metrics` (see **[Prometheus Integration](prometheus-integration.md)** and the **[full metrics reference](prometheus-metrics.md)**).

Tune the push interval with `OTEL_METRICS_EXPORT_INTERVAL_MS` (default `15000`).

## Event export

When an OTLP endpoint is configured, Monitor also emits discrete monitoring events as OTLP log records to `${endpoint}/v1/logs` (logger `betterdb-events`). These are the same events that drive webhooks: instance up/down, cluster failover, cluster bus corruption, and compliance alerts.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_INGEST_ENABLED` | `true` | Enable the `/v1/traces` OTLP trace receiver. |
| `OTEL_INGEST_TOKEN` | unset | Bearer token required to post traces. Required in cloud mode. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Base URL of your OTLP/HTTP collector. Setting it enables the metrics and event exports; `/v1/metrics` and `/v1/logs` are appended automatically. |
| `OTEL_TELEMETRY_ENABLED` | `true` | Set `false` to disable the metrics and event exports even when an endpoint is set. |
| `OTEL_METRICS_EXPORT_INTERVAL_MS` | `15000` | Metrics mirror push interval in milliseconds (minimum `1000`). |

## Kubernetes

The install chart wires the export endpoint through an env var. See **[Kubernetes install](install/kubernetes.md)** for a full manifest:

```yaml
env:
  - name: OTEL_EXPORTER_OTLP_ENDPOINT
    value: "http://otel-collector.observability.svc.cluster.local:4318"
```

## Summary

- **Traces:** Monitor receives OTLP traces at `/v1/traces` (JSON and protobuf). It does not export its own spans.
- **Metrics:** Prometheus-first at `/api/prometheus/metrics`; opt-in OTLP mirror of counters and gauges when an endpoint is set (histograms via Prometheus only).
- **Events:** opt-in OTLP logs for the same events that trigger webhooks.
