# betterdb-monitor Helm chart

Deploys [BetterDB Monitor](https://github.com/BetterDB-inc/monitor) — monitoring,
analytics, and anomaly detection for Valkey and Redis — on Kubernetes.

## Install

```bash
helm repo add betterdb https://docs.betterdb.com/charts
helm repo update
helm install betterdb-monitor betterdb/betterdb-monitor \
  --namespace betterdb --create-namespace \
  --set db.host=my-valkey.default.svc.cluster.local \
  --set db.password=yourpassword
```

Then open the dashboard (the release notes print the exact command):

```bash
kubectl port-forward -n betterdb svc/betterdb-monitor 3001:3001
```

Or install straight from a checkout of this repo:

```bash
helm install betterdb-monitor charts/betterdb-monitor -n betterdb --create-namespace
```

## Values

The full annotated reference is [values.yaml](values.yaml). The ones that matter:

| Key | Default | Description |
|-----|---------|-------------|
| `db.host` | `""` | Valkey/Redis to monitor. Empty = configure in the UI later. |
| `db.port` / `db.username` / `db.type` | `6379` / `default` / `auto` | Connection details. |
| `db.password` | `""` | Rendered into a chart-managed Secret. |
| `db.existingSecret` / `db.existingSecretKey` | `""` / `db-password` | Bring-your-own Secret instead. |
| `storage.type` | `memory` | `memory` (history lost on restart) or `postgres` (durable). |
| `storage.url` | `""` | `postgresql://user:pass@host:5432/db` when `storage.type=postgres`. |
| `storage.existingSecret` | `""` | Bring-your-own Secret holding the URL (key `storage-url`). |
| `image.tag` | `""` | Empty = `<appVersion>-no-ai` (standard image). Set `X.Y.Z` for the AI variant. |
| `service.type` / `service.port` | `ClusterIP` / `3001` | |
| `ingress.enabled` | `false` | Standard Ingress block (`className`, `hosts`, `tls`). |
| `persistence.enabled` | `false` | PVC at `/app/data` for license state (see below). |
| `license.key` | `""` | Online Pro/Enterprise license key. |
| `license.offline.existingSecret` | `""` | Secret with an offline `.jwt` token for air-gapped installs. |
| `license.offline.existingSecretKey` | `license.jwt` | Key within that Secret; also the mounted filename. Must match the Secret's key. |
| `resources` | requests `100m`/`256Mi`, limits `1`/`1Gi` | Pod CPU/memory. The 1Gi limit is a hard cap — raise it for busy instances. |
| `telemetry` | `true` | Set `false` to disable anonymous telemetry. |
| `extraEnv` / `extraEnvFrom` | `[]` | Any other env from [docs/configuration.md](../../docs/configuration.md). |

## Persistence

Two different kinds of state, two different knobs:

- **Monitoring history** (slowlogs, metrics, events) lives in the storage
  backend. The default `storage.type=memory` keeps it in the pod — fine for
  trying things out, gone on restart. Point `storage.type=postgres` +
  `storage.url` at a PostgreSQL instance for durable history.
- **License state** (offline tokens, the online outage-grace token) lives on
  disk under `/app/data`. `persistence.enabled=true` gives it a PVC so paid
  tiers survive pod rescheduling. The pod runs as UID 1001 and the chart sets
  `fsGroup: 1001`, so the volume is writable out of the box.

## Air-gapped licensing

```bash
kubectl create secret generic betterdb-license -n betterdb \
  --from-file=license.jwt=/path/to/betterdb-license.jwt

helm upgrade betterdb-monitor betterdb/betterdb-monitor -n betterdb --reuse-values \
  --set license.offline.existingSecret=betterdb-license \
  --set persistence.enabled=true
```

With an offline token and no online key, the monitor makes zero outbound
requests. See [docs/offline-licenses.md](../../docs/offline-licenses.md).

## Upgrade

```bash
helm repo update
helm upgrade betterdb-monitor betterdb/betterdb-monitor -n betterdb --reuse-values
```

## Releasing the chart (maintainers)

Chart.yaml is not templated, so a few version fields are hand-maintained. On an
**app release**, bump all of these to the new app version (they must agree with
`apps/api/package.json` — the publish workflow's preflight fails the build if
they drift):

- `appVersion`
- both tags under the `artifacthub.io/images` annotation (`<v>-no-ai` and `<v>`)

On **any chart change** (app release or chart-only fix), also bump `version`
(the chart's own SemVer) — the workflow skips a version whose tarball is already
published, so an unbumped `version` is a silent no-op.

Then merge to `master`. The `helm-publish.yml` workflow packages the chart and
rebuilds the index directly under `docs/charts/`, committing both to `master`
(signed, via the GitHub API) so GitHub Pages serves them at
`https://docs.betterdb.com/charts`. Both the `.tgz` tarballs and `index.yaml`
live in the repo under `docs/charts/`; there is no separate GitHub Release or
`gh-pages` branch.

The index commit to master requires the `HELM_PUBLISH_TOKEN` repo secret: a
fine-grained PAT (contents: read/write on this repo) from a user who bypasses
the PR-review rule. The workflow commits via GraphQL `createCommitOnBranch`,
so the commit is GitHub-signed and passes the signed-commits requirement.
