---
title: Kubernetes (Helm)
nav_order: 3
---

# Kubernetes Guide

BetterDB Monitor ships an official Helm chart. The chart deploys the monitor
itself; the Valkey/Redis instance it watches (and the optional PostgreSQL for
durable history) run wherever they already run — in-cluster, managed, or on a
VM.

## Run the betterdb-monitor Helm chart

```bash
helm repo add betterdb https://docs.betterdb.com/charts
helm repo update
helm install betterdb-monitor betterdb/betterdb-monitor \
  --namespace betterdb --create-namespace \
  --set db.host=my-valkey.default.svc.cluster.local \
  --set db.password=yourpassword
```

Open the dashboard:

```bash
kubectl port-forward -n betterdb svc/betterdb-monitor 3001:3001
# http://localhost:3001
```

`db.host` can be omitted — the monitor starts without a connection and you add
one in the UI. Inside a cluster, use the Kubernetes service DNS name of your
database (`<service>.<namespace>.svc.cluster.local`), not `localhost`.

## Override default values

Create a `values.yaml` with the values you want to override (see the annotated
defaults in
[charts/betterdb-monitor/values.yaml](https://github.com/BetterDB-inc/monitor/blob/master/charts/betterdb-monitor/values.yaml)),
then pass `-f values.yaml` to `helm install` / `helm upgrade`. A typical
production profile:

```yaml
db:
  host: my-valkey.default.svc.cluster.local
  existingSecret: my-valkey-auth        # key: db-password

storage:
  type: postgres                        # durable monitoring history
  existingSecret: my-monitor-storage    # key: storage-url

ingress:
  enabled: true
  className: nginx
  hosts:
    - host: monitor.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - hosts: [monitor.example.com]
      secretName: monitor-tls
```

## Persistent storage

Two kinds of state, two knobs:

- **Monitoring history** (slowlogs, metrics, anomaly events) lives in the
  storage backend, not on the pod's disk. The default `storage.type=memory`
  is ephemeral — history disappears on pod restart. Set
  `storage.type=postgres` and `storage.url` (or `storage.existingSecret`)
  for history that survives restarts and rescheduling.
- **License state** (offline tokens, the online outage-grace token) is kept
  under `/app/data`. Enable `persistence.enabled=true` to back it with a
  PersistentVolumeClaim so paid tiers survive rescheduling. The chart sets
  `fsGroup: 1001` to match the image's non-root user, so no manual `chown`
  is needed (unlike Docker volumes).

## Overriding configuration

Every environment variable from [Configuration](configuration.md) can be set
through the chart. First-class values exist for the common ones (`db.*`,
`storage.*`, `license.*`, `telemetry`); everything else goes under `extraEnv`:

```yaml
extraEnv:
  - name: ANOMALY_PROMETHEUS_INTERVAL_MS
    value: "15000"
  - name: OTEL_EXPORTER_OTLP_ENDPOINT
    value: "http://otel-collector.observability:4318"
```

Secrets never need to be inlined: `db.existingSecret`,
`storage.existingSecret`, `license.existingSecret`, and
`license.offline.existingSecret` all reference Secrets you manage yourself
(External Secrets, SealedSecrets, plain `kubectl create secret`, …).

### Air-gapped licensing

```bash
kubectl create secret generic betterdb-license -n betterdb \
  --from-file=license.jwt=/path/to/betterdb-license.jwt
```

```yaml
license:
  offline:
    existingSecret: betterdb-license
persistence:
  enabled: true
```

With an offline token and no online key the monitor makes zero outbound
requests. Details: [Offline licenses](offline-licenses.md).

## Upgrade the helm chart

```bash
helm repo update
helm upgrade betterdb-monitor betterdb/betterdb-monitor \
  --namespace betterdb --reuse-values
```

The default image tag is pinned to the chart's `appVersion` (the `-no-ai`
variant), so `helm upgrade` after a `repo update` moves you to the release the
chart was published for — no `:latest` surprises. Release notes:
[Updating](updating.md).
