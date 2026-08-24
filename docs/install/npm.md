---
title: npm / CLI
parent: Install
nav_order: 3
---

# Running BetterDB Monitor from the CLI

Run it without Docker:

```bash
npx @betterdb/monitor
```

On first run, an interactive setup wizard guides you through the database
connection, storage backend (SQLite, PostgreSQL, or in-memory), and server
port. Configuration is saved to `~/.betterdb/config.json`.

```bash
npm install -g @betterdb/monitor   # global install
betterdb --setup                   # re-run the setup wizard
betterdb --port 8080               # override the server port
betterdb --db-host 1.2.3.4         # override the database host
betterdb --help                    # all options
```

Requires Node.js >= 20 and a Valkey or Redis instance to monitor. For SQLite
storage, also `npm install -g better-sqlite3`.

Full environment and flag reference: [Configuration](../configuration.md).
