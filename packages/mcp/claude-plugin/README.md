# BetterDB plugin for Claude

Gives Claude direct access to your Valkey and Redis databases through [BetterDB Monitor](https://betterdb.com). Ask about instance health, slow commands, latency, memory, hot keys, client activity, anomalies and cluster state, and Claude answers from live metrics and history instead of guesses.

## Install

```bash
claude plugin marketplace add https://raw.githubusercontent.com/BetterDB-inc/monitor/master/.claude-plugin/marketplace.json
claude plugin install betterdb@betterdb
```

Claude Code asks for these settings when the plugin is enabled:

- **BetterDB URL**: the address of your BetterDB Monitor. Defaults to `http://localhost:3001`.
- **MCP token**: generated in BetterDB under **Settings → MCP Tokens**. It is stored in your system credential store, not in `settings.json`. Leave it empty for a local monitor that does not require auth.
- **Instance ID**: optional. For a monitor with several instances, the instance Claude starts each session on. Leave it empty to choose one with `select_instance`.
- **Usage telemetry**: on by default. Turn it off to stop the server posting usage events to your monitor.

You need Node.js 20 or later and a running BetterDB Monitor. On native Windows (not WSL), Claude Code can't launch `npx` directly; if the server fails to connect, add it by hand with `claude mcp add betterdb -- cmd /c npx -y @betterdb/mcp@1.6.0 --no-monitor-tools` instead of using the plugin. To run one locally, see the [monitor README](https://github.com/BetterDB-inc/monitor#readme).

## What it runs

The plugin starts one local MCP server over stdio: the [`@betterdb/mcp`](https://www.npmjs.com/package/@betterdb/mcp) package from npm, launched with `npx`. The package itself is pinned to an exact version; its dependencies (`@modelcontextprotocol/sdk` and `zod`) resolve within their published semver ranges. The server's source is in [`packages/mcp`](https://github.com/BetterDB-inc/monitor/tree/master/packages/mcp).

The plugin does not start a BetterDB Monitor. It runs the server with `--no-monitor-tools`, so the `start_monitor` and `stop_monitor` tools are not available.

## What it sends and fetches

- `npx` downloads `@betterdb/mcp` and its dependencies from the npm registry on first run.
- Every tool call is an HTTPS or HTTP request to the BetterDB URL you configured, with your token as a bearer token.
- After tool calls, the server posts usage events to the same BetterDB Monitor: tool name, success, duration and any error message. Turn off the **Usage telemetry** setting to stop this.

Some tools change state in BetterDB, such as adding or removing a database connection, so Claude Code asks before running them unless you allow them.

## License

MIT
