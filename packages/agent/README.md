# @betterdb/agent

Lightweight agent that connects your Valkey/Redis instances to [BetterDB Cloud](https://betterdb.com) for monitoring and observability — without exposing your database to the internet.

The agent runs inside your VPC and initiates **all connections outbound** via WebSocket (WSS on port 443). No inbound firewall rules required.

## Quick Start

### Docker (recommended)

```bash
docker run -d --name betterdb-agent \
  --restart=always \
  -e BETTERDB_TOKEN="<your-token>" \
  -e BETTERDB_CLOUD_URL="wss://<your-workspace>.app.betterdb.com/agent/ws" \
  -e VALKEY_HOST="<your-valkey-host>" \
  -e VALKEY_PORT="6379" \
  betterdb/agent
```

### npx

```bash
npx @betterdb/agent \
  --token "<your-token>" \
  --cloud-url "wss://<your-workspace>.app.betterdb.com/agent/ws" \
  --valkey-host "<your-valkey-host>" \
  --valkey-port 6379
```

## Configuration

| Variable / Flag | Default | Description |
|---|---|---|
| `BETTERDB_TOKEN` / `--token` | *(required)* | Agent token from BetterDB Cloud |
| `BETTERDB_CLOUD_URL` / `--cloud-url` | *(required)* | `wss://<workspace>.app.betterdb.com/agent/ws` |
| `VALKEY_HOST` / `--valkey-host` | `localhost` | Valkey/Redis hostname |
| `VALKEY_PORT` / `--valkey-port` | `6379` | Valkey/Redis port |
| `VALKEY_PASSWORD` / `--valkey-password` | — | Auth password |
| `VALKEY_USERNAME` / `--valkey-username` | `default` | ACL username |
| `VALKEY_TLS` / `--valkey-tls` | `false` | Enable TLS (required for ElastiCache Serverless) |
| `VALKEY_DB` / `--valkey-db` | `0` | Database number |

## Managed Services

Works with AWS ElastiCache, Google Memorystore, Azure Cache, Aiven, and others. Set `VALKEY_TLS=true` if the provider requires encryption. The agent must be deployed in the same VPC/network as your database.

## Networking & Security

- All connections are **outbound** — no inbound ports needed
- WebSocket uses WSS (TLS) on port 443
- Auto-reconnects with exponential backoff on disconnect
- Tokens can be revoked instantly from the BetterDB Cloud UI

## Documentation

Full docs: [docs.betterdb.com/agent-connection](https://docs.betterdb.com/agent-connection.html)

## License

See [LICENSE](https://github.com/BetterDB-inc/monitor/blob/master/LICENSE) for details.