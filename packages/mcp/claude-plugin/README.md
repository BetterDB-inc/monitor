# BetterDB plugin for Claude

Gives Claude direct access to your Valkey and Redis databases through [BetterDB Monitor](https://betterdb.com). Ask about instance health, slow commands, latency, memory, hot keys, client activity, anomalies and cluster state, and Claude answers from live metrics and history instead of guesses.

## Install

```bash
claude plugin marketplace add BetterDB-inc/monitor
claude plugin install betterdb@betterdb
```

Claude Code asks for these settings when the plugin is enabled:

- **BetterDB URL**: the address of your BetterDB Monitor. Defaults to `http://localhost:3001`.
- **MCP token**: generated in BetterDB under **Settings → MCP Tokens**. It is stored in your system credential store, not in `settings.json`. Leave it empty for a local monitor that does not require auth.
- **Usage telemetry**: on by default. Turn it off to stop the server posting usage events to your monitor.

You need Node.js 20 or later and a running BetterDB Monitor. To run one locally, see the [monitor README](https://github.com/BetterDB-inc/monitor#readme).

## What it runs

The plugin starts one local MCP server over stdio: the [`@betterdb/mcp`](https://www.npmjs.com/package/@betterdb/mcp) package from npm, pinned to an exact version and launched with `npx`. The server's source is in [`packages/mcp`](https://github.com/BetterDB-inc/monitor/tree/master/packages/mcp).

## What it sends and fetches

- `npx` downloads `@betterdb/mcp` and its dependencies from the npm registry on first run.
- Every tool call is an HTTPS or HTTP request to the BetterDB URL you configured, with your token as a bearer token. The server talks to no other host.
- After tool calls, the server posts usage events to the same BetterDB Monitor: tool name, success, duration and any error message. Turn off the **Usage telemetry** setting to stop this.

Some tools change state in BetterDB, such as adding or removing a database connection, so Claude Code asks before running them unless you allow them.

## License

MIT
