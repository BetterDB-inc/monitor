# @betterdb/mcp

Give your AI assistant deep visibility into your Valkey and Redis databases. The BetterDB MCP server connects Claude Code, Cursor, Windsurf, and other [MCP](https://modelcontextprotocol.io)-compatible clients to the [BetterDB](https://betterdb.com) monitoring platform — letting your AI query real-time metrics, diagnose slow commands, detect anomalies, and investigate incidents without leaving your editor.

## Why BetterDB?

BetterDB is a Valkey-first monitoring and observability platform providing real-time dashboards, anomaly detection, and operational intelligence for your Valkey and Redis deployments. Unlike tools that only show a live snapshot, BetterDB persists historical metrics, slowlogs, and audit trails — so you can investigate what happened yesterday, not just what's happening now.

Key capabilities exposed through MCP:

- **Real-time health checks** — memory fragmentation, hit rate, replication lag, connected clients
- **Slow command analysis** — slowlog and COMMANDLOG (Valkey 8+) with pattern aggregation
- **Hot key detection** — find cache-busting keys via LFU frequency scores or idle time analysis
- **Cluster-wide visibility** — per-node stats, aggregated slowlogs, and slot-level metrics across all nodes
- **Anomaly detection** — Z-score analysis on memory, CPU, hit rate, and other metrics *(Pro)*
- **Client activity tracking** — connection counts, command distribution, and buffer usage over time
- **ACL audit log** — investigate auth failures and access patterns
- **Latency event history** — track latency trends for specific event types

## Quick Start

### 1. Get a token

In BetterDB, go to **Settings → MCP Tokens** and generate a new token.

### 2. Configure your MCP client

Add to your MCP client config (e.g. Claude Code or OpenAI Codex):

```json
{
  "mcpServers": {
    "betterdb": {
      "type": "stdio",
      "command": "npx",
      "args": ["@betterdb/mcp"],
      "env": {
        "BETTERDB_URL": "https://<your-workspace>.app.betterdb.com",
        "BETTERDB_TOKEN": "<your-token>"
      }
    }
  }
}
```

For local development (token not required):

```json
{
  "mcpServers": {
    "betterdb": {
      "type": "stdio",
      "command": "npx",
      "args": ["@betterdb/mcp"],
      "env": {
        "BETTERDB_URL": "http://localhost:3001"
      }
    }
  }
}
```

### 3. Start asking questions

Once connected, your AI assistant can query your databases directly:

- *"What's the health of my production Valkey instance?"*
- *"Show me the slowest commands from the last hour"*
- *"Are there any hot keys causing uneven load?"*
- *"Which cluster node has the highest memory usage?"*
- *"Have there been any anomalies in the last 24 hours?"*

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `BETTERDB_URL` | `http://localhost:3001` | BetterDB instance URL (port depends on your Docker config) |
| `BETTERDB_TOKEN` | — | MCP token from Settings (required for cloud, optional for local) |
| `BETTERDB_INSTANCE_ID` | — | Pre-select a specific instance (skips `select_instance`) |

## Available Tools

| Tool | Description |
|---|---|
| `list_instances` | List all registered Valkey/Redis instances with connection status |
| `select_instance` | Select which instance subsequent calls operate on |
| `get_health` | Synthetic health summary — the best starting point for any investigation |
| `get_info` | Full INFO stats, optionally filtered by section |
| `get_slowlog` | Recent slow commands from the slowlog buffer |
| `get_commandlog` | Recent COMMANDLOG entries (Valkey 8+) |
| `get_latency` | Latency event history |
| `get_latency_history` | Detailed history for a specific latency event |
| `get_memory` | MEMORY DOCTOR assessment and MEMORY STATS breakdown |
| `get_clients` | Active client list with connection details |
| `get_hot_keys` | Hot key tracking data from LFU or idle time analysis |
| `get_slowlog_patterns` | Aggregated slowlog patterns with frequency and avg duration |
| `get_commandlog_history` | Persisted COMMANDLOG entries with time range filtering |
| `get_commandlog_patterns` | Aggregated COMMANDLOG patterns |
| `get_anomalies` | Anomaly detection events *(Pro)* |
| `get_client_activity` | Time-bucketed client activity from persisted snapshots |
| `get_acl_audit` | ACL audit log entries |
| `get_cluster_nodes` | Cluster node discovery — roles, health, slot ranges |
| `get_cluster_node_stats` | Per-node performance stats across the cluster |
| `get_cluster_slowlog` | Aggregated slowlog across all cluster nodes |
| `get_slot_stats` | Per-slot key counts and CPU usage (Valkey 8+) |

## Requirements

- Node.js 20+
- A running [BetterDB](https://betterdb.com) instance (cloud or self-hosted)

## Documentation

Full docs: [docs.betterdb.com](https://docs.betterdb.com)

## License

See [LICENSE](https://github.com/BetterDB-inc/monitor/blob/master/LICENSE) for details.
