---
title: Troubleshooting
nav_order: 6
---

# Troubleshooting Guide

Common issues and solutions for BetterDB Monitor.

## Connection Issues

### "Connection refused" error

**Symptoms:** BetterDB cannot connect to your Valkey/Redis instance.

**Solutions:**

1. Verify the host is reachable: `ping your-valkey-host`
2. Check the port is open: `nc -zv your-valkey-host 6379`
3. If using Docker, ensure network connectivity:
   - Use `--network host` for localhost connections
   - Or use the container's IP/hostname on the Docker network
4. Verify credentials if ACL is enabled

### "NOAUTH Authentication required"

**Symptoms:** Connection fails with authentication error.

**Solutions:**

1. Set `DB_PASSWORD` environment variable
2. If using ACL with username: set both `DB_USERNAME` and `DB_PASSWORD`
3. Verify credentials work with CLI: `valkey-cli -h host -p port -a password PING`

## Storage Issues

### "STORAGE_URL is required for PostgreSQL storage"

**Symptoms:** App fails to start with PostgreSQL storage type.

**Solutions:**

1. Ensure `STORAGE_URL` is set when using `STORAGE_TYPE=postgres`
2. Format: `postgresql://user:password@host:port/database`
3. Verify PostgreSQL is accessible from the container

### "Local SQLite files require the better-sqlite3 native module"

**Symptoms:** `STORAGE_TYPE=sqlite` fails to start in Docker.

**Solutions:**

- The `better-sqlite3` native module is stripped from the `latest` (no-AI) image for size optimization
- Use `STORAGE_TYPE=turso` with a remote `STORAGE_URL` for SQLite semantics in Docker, or `STORAGE_TYPE=postgres` / `STORAGE_TYPE=memory`
- Local file storage is available in local development (`pnpm dev`) and in the AI image

### "STORAGE_URL is required for Turso storage"

**Symptoms:** `STORAGE_TYPE=turso` refuses to start.

**Solutions:**

1. Set `STORAGE_URL` to your libSQL endpoint, e.g. `libsql://your-db-your-org.turso.io`
2. Set `STORAGE_AUTH_TOKEN` - it is required whenever `STORAGE_URL` starts with `libsql://`
3. Confirm the token is valid: `turso db tokens create <database>`

### Turso starts, then every query fails to authenticate

**Symptoms:** `STORAGE_TYPE=turso` boots without complaint, then each storage read or write returns an auth error.

**Cause:** the auth token is only required at startup for `libsql://` URLs. `https://` and `http://` stay optional so a self-hosted or local `sqld` can run unauthenticated, so a hosted `https://` URL with a missing or empty `STORAGE_AUTH_TOKEN` passes validation and fails on the first query.

**Solutions:**

1. Set `STORAGE_AUTH_TOKEN`, or switch `STORAGE_URL` to the `libsql://` form so the missing token is caught at startup
2. Confirm the token is valid: `turso db tokens create <database>`

## Docker Issues

### Container marked as unhealthy

**Symptoms:** `docker ps` shows container as unhealthy.

**Solutions:**

1. Check if the app started: `docker logs betterdb-monitor`
2. Verify port mapping matches PORT env var
3. Health check expects response at `/health` endpoint
4. Wait for start period (5 seconds) to complete

### "Port already in use"

**Symptoms:** Container fails to start due to port conflict.

**Solutions:**

1. Change the port: `-p 8080:8080 -e PORT=8080`
2. Find what's using the port: `lsof -i :3001`
3. Stop conflicting service or use different port

## Prometheus/Metrics Issues

### Metrics endpoint returns empty

**Symptoms:** `/api/prometheus/metrics` returns minimal data.

**Solutions:**

1. Wait for first poll cycle (metrics populate after ~5 seconds)
2. Verify database connection is healthy
3. Check logs for polling errors

### Missing Valkey-specific metrics

**Symptoms:** `betterdb_commandlog_*` metrics not appearing.

**Explanation:** Valkey-specific metrics only populate when:

- Connected to Valkey (not Redis)
- The specific feature is available for that version
- Data exists (e.g., COMMANDLOG has entries)

## Slow Log / Command Log Issues

### "Entries were never captured" warning on the Slow Log page

**Symptoms:** The Slow Log page shows *"N slow log entries were never captured in the last 24 hours"* (or the same for a command log tab).

**Explanation:** Valkey and Redis keep only the newest `slowlog-max-len` (default 128) slow log entries, and the newest `commandlog-*-max-len` entries per command log type. BetterDB reads each log every 30 seconds. When more entries are logged between two reads than the server keeps, the oldest are overwritten before BetterDB sees them. Every entry carries an id that only ever increases (it is not reset by `SLOWLOG RESET` / `COMMANDLOG RESET`), so BetterDB counts exactly how many ids it never received and records each gap.

BetterDB first tries to recover: when the regular 128-entry read does not reach back to the last entry it stored, it reads up to 1,024 entries in the same poll, so a server with a larger `*-max-len` loses nothing. The warning only appears when entries were really gone.

Each gap has a cause:

| Cause | Meaning | What to do |
|-------|---------|------------|
| Overwritten by the server | More entries arrived in one poll interval than the server keeps | Raise the `*-max-len` shown in the warning, e.g. `CONFIG SET slowlog-max-len 1024`, and persist it in your config file. On ElastiCache and MemoryDB change it in the parameter group; on Redis Cloud `CONFIG SET` works but the allowed range is 128-1024, so use 1024 and raise the logging threshold instead of going higher. Each retained entry costs memory, so prefer the suggested value over a much larger one. |
| Over the per-poll read limit | More than 1,024 entries arrived between two polls | Raise the logging threshold (`slowlog-log-slower-than`, `commandlog-execution-slower-than`, `commandlog-request-larger-than` or `commandlog-reply-larger-than`) so only commands worth investigating are logged |
| While BetterDB was not polling | BetterDB was restarting or unreachable | Nothing on the server; the gap covers the time BetterDB was down |

The suggested value is twice the largest burst seen in the window, rounded up to a power of two, between 256 and 8192. When a single burst is larger than 8192, no retained length recommended by BetterDB covers it: the warning then tells you to raise the logging threshold (`slowlog-log-slower-than` or the `commandlog-*` equivalent) so fewer commands are logged.

When `*-max-len` is above 1024 and a burst exceeds the per-poll read limit, BetterDB reads the setting (cached for five minutes) and splits the hole into the part the server had already evicted and the part it still held but BetterDB did not read in that poll, so each gets the right remedy.

A server restart is detected through the `run_id` in `INFO server`: the capture baseline is reset and the restart is not reported as a gap, even when the restarted server has already logged past the last stored id.

**API:**

```bash
# Per-log totals for the last 24 hours (windowHours: 1-720)
curl -b cookies.txt -H "x-connection-id: <id>" "http://localhost:3001/api/log-capture/summary?windowHours=24"

# Individual gaps, newest first
curl -b cookies.txt -H "x-connection-id: <id>" "http://localhost:3001/api/log-capture/gaps?logType=slowlog&limit=50"
```

Gap records follow the same retention as the slow log itself.

**Known limitation:** if the server restarts while BetterDB is down and logs more entries than BetterDB had already stored, the new ids overlap the old range and BetterDB cannot tell the restart apart from a gap. The gap is then reported as *while BetterDB was not polling*.

## Getting Help

If your issue isn't listed here:

1. Check the [GitHub Issues](https://github.com/BetterDB-inc/monitor/issues) for similar problems
2. Open a new issue with:
   - BetterDB version
   - Database type and version
   - Error messages and logs
   - Steps to reproduce
3. For urgent issues, email support@betterdb.com
