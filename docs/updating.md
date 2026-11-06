---
title: Updating
nav_order: 10
---

# Updating BetterDB Monitor

Newer releases ship **new features and security fixes**, so we recommend keeping
BetterDB Monitor up to date. When a newer version is available, an update banner
appears at the top of the dashboard showing the current and latest versions.

Where it can, the banner detects how your instance was launched (Docker, npx, or
a global install) and offers a one-click **copy** of the exact upgrade command.
This page is the complete reference, including the cases the banner can't
auto-detect (Kubernetes, custom deployments).

> **Your data is safe across upgrades.** Metrics, connections, audit logs, and
> settings live in the BetterDB data volume/directory, not in the application
> image or package. Upgrading replaces only the application. Keep pointing the
> new version at the same volume (Docker) or the same `BETTERDB_DATA_DIR`
> (CLI) and your history carries over.

## Check your current version

- **Dashboard** — the version is shown at the bottom of the sidebar, and in the
  update banner (`current → latest`).
- **API** — `GET /version` returns the current version, the latest known
  version, and whether an update is available:

  ```bash
  curl http://localhost:3001/api/version
  ```

## Docker

Pull the latest image, then recreate the container against your existing data
volume:

```bash
docker pull betterdb/monitor:latest

# Recreate the container (replace the name/flags with your own run command)
docker rm -f betterdb 2>/dev/null
docker run -d \
  --name betterdb \
  -p 3001:3001 \
  -v betterdb-data:/app/data \
  -e BETTERDB_LICENSE_KEY=your-license-key \
  betterdb/monitor:latest
```

Pin a specific version instead of `latest` when you want reproducible
deployments, e.g. `betterdb/monitor:<version>` using the tag from the
[release notes](#release-notes).

### Docker Compose

```bash
docker compose pull
docker compose up -d
```

Compose recreates only the containers whose image changed and preserves named
volumes, so your data is retained automatically.

### Podman

```bash
podman pull betterdb/monitor:latest
# then recreate the container as in the Docker example above
```

## CLI (npm / pnpm / yarn / npx)

The CLI is published to npm as
[`@betterdb/monitor`](https://www.npmjs.com/package/@betterdb/monitor).

### Ephemeral runners (npx / dlx)

If you launched the CLI with a runner, just re-run it with `@latest` — this is
what the update banner suggests when it detects one. Pin `@latest` to bypass any
locally cached copy:

```bash
npx @betterdb/monitor@latest        # npm
pnpm dlx @betterdb/monitor@latest   # pnpm
yarn dlx @betterdb/monitor@latest   # Yarn Berry (v2+)
```

### Global install

If you installed the CLI globally, upgrade it in place:

```bash
npm install -g @betterdb/monitor@latest    # npm
pnpm add -g @betterdb/monitor@latest       # pnpm
yarn global add @betterdb/monitor@latest   # Yarn Classic (v1) — Berry dropped `yarn global`, use `yarn dlx` above
```

Your configuration and stored data live in `~/.betterdb` (or `BETTERDB_DATA_DIR`)
and are untouched by re-installing.

## Kubernetes

**Official Helm chart** (see the [Kubernetes guide](kubernetes)): each chart
release pins the image to the version it was published for, so updating is
just pulling the newer chart:

```bash
helm repo update
helm upgrade betterdb-monitor betterdb/betterdb-monitor \
  --namespace betterdb --reset-then-reuse-values
```

`--reset-then-reuse-values` (Helm 3.14+) keeps your overrides but picks up
the new chart's defaults, such as a longer startup probe. `--reuse-values`
keeps the old release's defaults too, so a changed default never reaches an
existing install. On older Helm, pass your values file with `-f` instead.

Don't override `image.tag` to update — leave it empty and let the chart's
`appVersion` drive the image, so chart and app versions move together and
`helm rollback` restores both.

**Plain manifests**: update the image tag on your deployment:

```bash
# replace <version> with the release you are moving to (see the release notes below)
kubectl set image deployment/betterdb betterdb=betterdb/monitor:<version>
```

Use a versioned tag rather than `latest` so rollouts are deterministic and
roll-backable. Historical data lives in your storage backend (`STORAGE_TYPE`),
not the pod, so it survives rollouts as long as you keep pointing at the same
PostgreSQL instance — with in-memory storage it is lost on every restart.

## After updating

- The banner disappears automatically once the running version matches the
  latest release.
- Dismissing the banner hides it only until the *next* newer version is
  published — it is not a permanent opt-out.
- BetterDB checks for updates about once an hour. Tune this with the
  `VERSION_CHECK_INTERVAL_MS` environment variable (see
  [Configuration](configuration)).

## Schema changes on large databases

Some releases add indexes or tables. How that affects startup depends on the
storage backend:

- **PostgreSQL**: new indexes on large history tables are built in the
  background with `CREATE INDEX CONCURRENTLY` after the API is ready, so
  startup is not blocked and writes continue during the build. A build cut
  short by a restart leaves an invalid index that the next startup drops and
  rebuilds. The startup log reports when each index is ready.
- **SQLite**: indexes are created during schema setup, before the HTTP server
  starts listening, at roughly 1.5 seconds per million rows in the table
  (measured: 15 seconds for 8 million `client_snapshots` rows). The build is
  a single transaction, so a restart mid-build leaves nothing behind and the
  next start simply builds it again. On Kubernetes this time counts against
  the startup probe (the chart allows 10 minutes), not the liveness probe.
  Only a SQLite database approaching 100 million history rows would need
  the probe budget raised; at that size PostgreSQL is the better backend.

## Slow log and command log keys (PostgreSQL)

Slow log and command log entries are now keyed by the server process that
logged them (its `run_id`), not only by the address they were read from. The
first start after updating rebuilds the unique keys of `slow_log_entries` and
`command_log_entries` before the API is ready, and drops the old keys. On a
large database this counts against the startup probe. The chart allows 10
minutes for it; an install upgraded with `--reuse-values` keeps the old 150
seconds, so upgrade with `--reset-then-reuse-values` or set
`startupProbe.failureThreshold` (e.g. `--set startupProbe.failureThreshold=120`).

- **First poll after updating**: entries stored before the update carry no
  `run_id`, so the entries still in each server's log (at most 128 per log
  type) are stored once more under that server's `run_id`, and history can
  show them twice. This happens once. Resuming from the old rows instead
  could skip entries for good on a seed that fronts several nodes, whose old
  rows mix the log IDs of different nodes.
- **Rolling updates**: until every replica runs the new version, the old
  replicas fail to store slow and command log entries, because their inserts
  name the dropped key. The new replicas resume from what is stored, so
  entries still in each server's log are stored once the rollout finishes.
- **Rolling back**: the older version cannot store slow or command log entries
  until the old keys exist again. Before starting it, run:

```sql
DELETE FROM slow_log_entries a USING slow_log_entries b
 WHERE a.pk > b.pk AND a.slowlog_id = b.slowlog_id AND a.source_host = b.source_host
   AND a.source_port = b.source_port AND a.connection_id = b.connection_id;
ALTER TABLE slow_log_entries ADD CONSTRAINT slow_log_entries_legacy_key
  UNIQUE (slowlog_id, source_host, source_port, connection_id);

DELETE FROM command_log_entries a USING command_log_entries b
 WHERE a.pk > b.pk AND a.commandlog_id = b.commandlog_id AND a.log_type = b.log_type
   AND a.source_host = b.source_host AND a.source_port = b.source_port
   AND a.connection_id = b.connection_id;
ALTER TABLE command_log_entries ADD CONSTRAINT command_log_entries_legacy_key
  UNIQUE (commandlog_id, log_type, source_host, source_port, connection_id);
```

  The `DELETE` keeps one entry where entries from different server processes
  share an ID and address, which the old key cannot tell apart. Updating again
  drops these constraints automatically.

## Release notes

Every banner links to the release notes for the target version. You can also
browse all releases on
[GitHub](https://github.com/betterdb-inc/monitor/releases).
