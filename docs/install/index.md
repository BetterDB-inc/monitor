---
title: Install
nav_order: 2
has_children: true
---

# Installing BetterDB Monitor

BetterDB Monitor is a single container (backend + dashboard) that connects to
the Valkey or Redis instance you want to watch. Run it whichever way fits your
environment — every method ships the same product and serves the dashboard on
port 3001 by default.

| Method | Best for | One-liner |
|--------|----------|-----------|
| [Docker](docker.md) | Quickest start, servers, air-gapped hosts | `docker run -d -p 3001:3001 betterdb/monitor:latest` |
| [Kubernetes (Helm)](kubernetes.md) | Clusters, GitOps, durable / HA installs | `helm install betterdb-monitor betterdb/betterdb-monitor` |
| [npm / CLI](npm.md) | Local runs without Docker, laptops | `npx @betterdb/monitor` |
| [LLM (MCP)](llm.md) | Driving the monitor from Claude or an MCP client | `npx @betterdb/mcp` |

Storage (in-memory, PostgreSQL, or SQLite), licensing, and every tunable are
shared across all methods — see [Configuration](../configuration.md).

## Which should I use?

- **Just trying it out** — [Docker](docker.md). One command, open `localhost:3001`.
- **Running in Kubernetes** — the [Helm chart](kubernetes.md), which layers
  Secrets, persistence, ingress, and air-gapped licensing on top of the image.
- **No Docker on the box** — the [npm CLI](npm.md), which walks you through setup.
- **You want your AI assistant to query the database** — the [MCP server](llm.md).
