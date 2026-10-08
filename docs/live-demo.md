# Live demo: Prometheus, Grafana, and OTLP

The hosted demo workspace at `https://demo.app.betterdb.com` is a regular
BetterDB Monitor cloud instance — the same container every tenant runs. Its
observability surface is public so you can try the integrations against live
data before wiring up your own instance.

## Hosted Grafana

**`https://demo-grafana.app.betterdb.com`** — read-only, no login.

It renders the shipped dashboard pack
([`deploy/observability/dashboards/`](../deploy/observability/dashboards/))
against the demo workspace: Instance Vitals, Query Patterns, Cluster Slots,
and Anomalies. These are the exact JSON files you can import into your own
Grafana — nothing demo-specific.

## Scrape the demo yourself

The demo's metrics endpoint accepts a published bearer token, available on
the live-demo page at betterdb.com. Point any Prometheus at it:

```yaml
scrape_configs:
  - job_name: 'betterdb-demo'
    scheme: https
    metrics_path: '/api/prometheus/metrics'
    authorization:
      type: Bearer
      credentials: <published demo token>
    static_configs:
      - targets: ['demo.app.betterdb.com']
```

You'll get the full exposition — 110+ `betterdb_*` series, every one labeled
by `connection` — exactly what your own instance exposes
(see [prometheus-metrics.md](prometheus-metrics.md)). Then import the
dashboard pack, select your datasource in the **Data source** variable, and
the demo's data renders in your Grafana.

The endpoint is rate-limited per IP; a normal scrape interval (≥15s) stays
far below the cap. The published token is read-only and rotated periodically —
re-copy it from the live-demo page on betterdb.com if a scrape starts
returning 401.

A quick one-off look without Prometheus:

```bash
curl -H "Authorization: Bearer <published demo token>" \
  https://demo.app.betterdb.com/api/prometheus/metrics
```

## OTLP

The hosted Grafana is itself fed over OTLP: the demo instance pushes its
metrics with the built-in OTLP mirror
(`OTEL_EXPORTER_OTLP_ENDPOINT` + `OTEL_METRICS_EXPORT_MODE=mirror`) straight
into a Prometheus OTLP receiver — no collector in between. Your own instance
can do the same toward any OTLP backend.

Monitor also **ingests** OTLP — traces on `POST /v1/traces` and metrics from
instances it can't dial directly on `POST /v1/external/metrics` — rendered in
the AI Traces view and the connection switcher. Ingest is token-guarded and
not publicly exposed on the demo; see
[opentelemetry.md](opentelemetry.md) for running it against your own
deployment.

## Trying everything locally instead

`deploy/observability/demo/` is a docker-compose stack with the same pieces
(Monitor, Prometheus, Grafana, plus an OTel Collector) against a seeded
Valkey — see the [observability pack README](../deploy/observability/README.md).
