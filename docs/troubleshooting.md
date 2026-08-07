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

### "SQLite storage is not available in this build"

**Symptoms:** Cannot use SQLite storage in Docker.

**Solutions:**
- SQLite is excluded from Docker builds for size optimization
- Use `STORAGE_TYPE=postgres` or `STORAGE_TYPE=memory` instead
- SQLite is only available for local development (`pnpm dev`)

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

## Getting Help

If your issue isn't listed here:

1. Check the [GitHub Issues](https://github.com/BetterDB-inc/monitor/issues) for similar problems
2. Open a new issue with:
   - BetterDB version
   - Database type and version
   - Error messages and logs
   - Steps to reproduce
3. For urgent issues, email support@betterdb.com
