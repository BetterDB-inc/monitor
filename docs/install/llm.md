---
title: LLM (MCP)
parent: Install
nav_order: 4
---

# Using BetterDB from an LLM (MCP)

BetterDB ships an MCP server — 60 tools that let Claude Code, Cursor, or any MCP
client query your database's health, slow queries, memory, and analytics in
plain language.

## Add to Claude Code

```bash
claude mcp add betterdb -- \
  npx @betterdb/mcp betterdb-mcp \
  --autostart --persist
```

This adds BetterDB as an MCP server and starts monitoring automatically. Then
ask Claude about your database health, slow queries, or memory usage.

## Any MCP client (stdio)

```bash
npx @betterdb/mcp
```

Create a token under **Settings → MCP Tokens** in the dashboard to authenticate
the server against a running monitor.

See [Packages](../packages.md) for the full tool list and the
[`@betterdb/mcp`](https://www.npmjs.com/package/@betterdb/mcp) package.
