# Observability pack

An OpenTelemetry Collector config, a Grafana dashboard pack, and a
docker-compose demo that shows BetterDB Monitor, the Collector, Prometheus,
and Grafana running side by side against a seeded Valkey instance.

## What's here

- `collector/otel-collector.yaml` — base Collector config: OTLP receiver on
  grpc `:4317` and http `:4318`, exporting to a Prometheus scrape endpoint on
  `:8889`.
- `collector/otel-collector.fanout.yaml` — the same intake, fanned out to
  Prometheus and a second OTLP backend via `SECONDARY_OTLP_ENDPOINT`.
- `dashboards/betterdb-instance-vitals.json` — memory, CPU, ops/sec, hit
  rate, clients, replication, and uptime for a connection.
- `dashboards/betterdb-query-patterns.json` — slowlog and commandlog pattern
  analysis: top slow-query patterns, large requests/replies, slowest
  commands.
- `dashboards/betterdb-cluster-slots.json` — cluster health and per-slot key
  distribution, hottest slots, and read/write rates.
- `dashboards/betterdb-anomalies.json` — anomaly and correlated-group counts
  by severity/metric/pattern, detector baselines, and forecasted time to
  limit.
- `demo/docker-compose.yml` — Valkey, BetterDB Monitor, the Collector,
  Prometheus, and Grafana wired together.
- `demo/prometheus.yml` — scrapes the monitor directly (job `betterdb`) and
  the Collector's Prometheus exporter (job `otel-collector`), so both paths
  land in the same Prometheus.
- `demo/grafana/provisioning/` — auto-provisions the Prometheus datasource
  and the dashboard pack into Grafana.
- `demo/seed/seed.sh` — generates keyspace traffic, cache hits/misses, a
  slow command, and an oversized reply.

## Dashboard variables

Every dashboard in the pack carries three variables:

- **Data source** (`ds`) — any Prometheus datasource in the Grafana it runs
  in. It defaults to the default datasource, which the demo provisions.
- **Scrape job** (`job`) — which scrape job to read. The same series arrive
  twice when Prometheus scrapes both the monitor and the Collector, so the
  panels always read exactly one of them. Pick `betterdb` for the direct
  path or `otel-collector` for the OTLP round trip.
- **Connection** (`connection`) — the monitored instances to chart, scoped
  to the selected scrape job.

## Importing a dashboard into an existing Grafana

In Grafana: **Dashboards → New → Import**, upload one of the JSON files from
`dashboards/`, and open it. The panels read the **Data source** variable
rather than a fixed datasource uid, so pick your Prometheus from that
dropdown at the top of the dashboard — there is nothing to remap.

## Pointing an existing Collector at the monitor

If you already run a Collector, there's no need to run the demo stack:

1. Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector>:4318` on the monitor
   (and `OTEL_TELEMETRY_ENABLED=true` if it isn't already).
2. Scrape the Collector's Prometheus exporter at `:8889`.

`collector/otel-collector.yaml` shows a minimal config that does this; merge
its `otlp` receiver and `prometheus` exporter into your own pipeline, or add
`SECONDARY_OTLP_ENDPOINT` support from `collector/otel-collector.fanout.yaml`
if you also want to fan the same stream out to another backend.

## Running the demo

```bash
cd deploy/observability/demo
docker compose up -d
docker compose exec -T valkey sh < seed/seed.sh
```

Then open `http://localhost:3000`. Grafana is provisioned with anonymous
admin access and the BetterDB dashboard pack. The compose file is a demo
only — it hardcodes a password and leaves Grafana open — not a deployment
template.

The seed script talks to Valkey over the Docker network, so it has to run
inside the `valkey` container — the compose file doesn't publish a Valkey
port to the host, and the host doesn't need `valkey-cli` installed.

### What the demo actually shows

- **Instance Vitals** — populated as soon as the monitor polls; the seed
  script drives memory, ops/sec, hit rate, and client counts.
- **Query Patterns** — populated by the seed script's slow command and
  oversized request/reply.
- **Anomalies** — populated a minute or two after seeding, once the
  detectors have a rolling baseline; "Detector buffers" shows the warm-up
  state per detector in the meantime. "Time to limit" stays empty until the
  forecaster has enough history to project a limit.
- **Cluster Slots** — empty. The demo runs a standalone Valkey, which has
  no cluster bus and no `CLUSTER SLOT-STATS`; that dashboard needs a
  cluster-mode deployment.

## Ports

| Port | Service                       |
| ---- | ----------------------------- |
| 3000 | Grafana                       |
| 3001 | BetterDB Monitor              |
| 9090 | Prometheus                    |
| 4317 | Collector OTLP gRPC           |
| 4318 | Collector OTLP HTTP           |
| 8889 | Collector Prometheus exporter |
