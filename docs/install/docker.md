---
title: Docker
parent: Install
nav_order: 1
---

# Running BetterDB Monitor with Docker

## Quick start

```bash
docker run -d --name betterdb -p 3001:3001 betterdb/monitor:latest
```

Open [http://localhost:3001](http://localhost:3001). To monitor a specific
instance, pass its connection:

```bash
docker run -d --name betterdb -p 3001:3001 \
  -e DB_HOST=your-valkey-host \
  -e DB_PORT=6379 \
  -e DB_PASSWORD=your-password \
  betterdb/monitor:latest
```

> **Connecting to a database on your host machine?** Inside the container
> `localhost` is the container itself, so use `host.docker.internal` as the
> database host. It works out of the box on Docker Desktop; on Linux add
> `--add-host=host.docker.internal:host-gateway`.

## Image variants

Both are multi-arch (`linux/amd64`, `linux/arm64`):

| Tag | What it is |
|-----|------------|
| `latest`, `X.Y.Z-no-ai` | Default — every monitoring feature, without the experimental local-LLM AI Helper dependencies |
| `X.Y.Z` | Adds the experimental AI Helper (bring your own Ollama; disabled by default via `AI_ENABLED`) |

## Going further

PostgreSQL storage for durable history, custom ports, replacing a running
container, building the image, and image internals are all covered in the
Docker reference: [Configuration → Docker Usage](../configuration.md#docker-usage).
The full environment-variable list is in [Configuration](../configuration.md).
