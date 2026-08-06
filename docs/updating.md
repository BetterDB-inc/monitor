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
  curl http://localhost:3001/version
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
deployments, e.g. `betterdb/monitor:0.32.0`.

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

### npx (no install)

`npx` always resolves the latest published version, so re-running already picks
up updates. Pin `@latest` to bypass any locally cached copy:

```bash
npx @betterdb/monitor@latest
```

### Global install

```bash
# npm
npm install -g @betterdb/monitor@latest

# pnpm
pnpm add -g @betterdb/monitor@latest

# yarn
yarn global add @betterdb/monitor@latest
```

Your configuration and stored data live in `~/.betterdb` (or `BETTERDB_DATA_DIR`)
and are untouched by re-installing.

## Kubernetes

Update the image tag on your deployment. The exact command depends on how you
deploy — a couple of common shapes:

```bash
# Plain manifests
kubectl set image deployment/betterdb betterdb=betterdb/monitor:0.32.0

# Helm
helm upgrade betterdb betterdb/monitor --set image.tag=0.32.0
```

Use a versioned tag rather than `latest` so rollouts are deterministic and
roll-backable. Ensure your PersistentVolumeClaim is retained across the rollout
to keep historical data.

## After updating

- The banner disappears automatically once the running version matches the
  latest release.
- Dismissing the banner hides it only until the *next* newer version is
  published — it is not a permanent opt-out.
- BetterDB checks for updates about once an hour. Tune this with the
  `VERSION_CHECK_INTERVAL_MS` environment variable (see
  [Configuration](configuration)).

## Release notes

Every banner links to the release notes for the target version. You can also
browse all releases on
[GitHub](https://github.com/betterdb-inc/monitor/releases).
