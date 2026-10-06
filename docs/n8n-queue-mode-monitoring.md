---
title: Monitoring n8n queue mode (Redis/Valkey) with BetterDB Monitor
nav_order: 12
---

# Monitoring n8n queue mode (Redis/Valkey) with BetterDB Monitor

In queue mode, n8n puts every execution on Redis (or Valkey) through BullMQ.
The main process enqueues jobs, the workers pull them off, and that one
instance is the thing the whole fleet depends on. When it degrades, workers
go quiet and jobs pile up, but n8n's own process healthchecks can keep
reporting OK. This page shows how to watch that instance with BetterDB
Monitor so you see the trouble before the backlog does.

## The failure this catches

A real incident (n8n issue [#37581](https://github.com/n8n-io/n8n/issues/37581))
is the clearest motivation. On a queue-mode deploy backed by AWS ElastiCache
Valkey with TLS, a one-second network blip left the workers' sockets
half-open. For 69 minutes:

- All four workers stopped consuming. Not one logged anything Redis-related.
- The Valkey server's client count dropped from 54 to ~16 and stayed there.
- Bull's blocking `BRPOPLPUSH` connection hung forever on the dead socket.
- Jobs accumulated in the `waiting` state, peaking around 252.
- The worker processes, their Docker healthchecks, and `/healthz/readiness`
  all stayed green the entire time.

None of n8n's in-process signals noticed, because the process was alive and
the socket looked connected. An external watcher on the Redis/Valkey side
sees all of it: the connection count collapse, the blocked client that never
returns, and a `bull` keyspace that grows and never drains.

## What BetterDB Monitor shows for a BullMQ instance

Monitor connects to the same instance BullMQ uses and reports the signals
that map directly onto the incident above:

- **Connected clients and client activity** — the worker connections and
  their state. A sudden drop in client count, or a `BRPOPLPUSH` client stuck
  blocked, is the first sign workers have stopped consuming.
- **Keyspace and memory by key** — the `bull:*` keys. A `bull:<queue>:wait`
  list that keeps growing while `active` stays flat is a stalled queue, not a
  busy one.
- **Slowlog and latency** — command-level slow spots and latency spikes on
  the queue instance.
- **Anomaly detection** — connection-count collapses and other step changes
  surface as events instead of waiting to be noticed on a dashboard.

Because Monitor runs as its own process against the instance, it reports the
truth even when the n8n side still says it is healthy.

## Wiring it up with Docker Compose

If you run the queue-mode compose from
[`n8n-hosting`](https://github.com/n8n-io/n8n-hosting/tree/main/docker-compose/withPostgresAndWorker)
(`withPostgresAndWorker`), add Monitor as one more service pointed at the
existing `redis` service. It needs no changes to n8n itself.

```yaml
services:
  # ... existing n8n, n8n-worker, postgres, redis services ...

  betterdb-monitor:
    image: betterdb/monitor
    restart: always
    environment:
      - DB_HOST=redis
      - DB_PORT=6379
      # Set these if your redis service requires auth / TLS:
      # - DB_PASSWORD=${REDIS_PASSWORD}
      # - DB_TLS=false
    ports:
      - '3001:3001'
    depends_on:
      - redis
```

Open the UI on the mapped port and you are watching the same instance your
workers pull jobs from.

## Wiring it up with Helm

The [`n8n` Helm chart](https://github.com/n8n-io/n8n-hosting/tree/main/charts/n8n)
already holds the connection details Monitor needs: `redis.host`,
`redis.username`, `redis.tls`, `redis.clusterNodes`, and a
`redis.passwordSecret` reference. Deploy the
[`betterdb-monitor` chart](https://github.com/BetterDB-inc/monitor/tree/master/charts/betterdb-monitor)
into the same namespace and reuse those same values.

For a managed target such as ElastiCache or Memorystore, TLS is required.
Set `db.tls=true`; the TLS SNI servername is derived from `db.host`
automatically, so a bare hostname is all you need.

```bash
helm install betterdb-monitor ./charts/betterdb-monitor -n n8n \
  --set db.host="$REDIS_HOST" \
  --set db.username=default \
  --set db.tls=true \
  --set db.existingSecret=redis \
  --set db.existingSecretKey=redis-password
```

Point `db.existingSecret` / `db.existingSecretKey` at the same secret the n8n
chart reads for `redis.passwordSecret`, so there is one password to rotate,
not two. For Redis Cluster targets, set `db.host` to any node; Monitor
discovers the topology.

## Verifying

1. Open the Monitor UI and confirm it is connected to the queue instance.
2. Check the client list: you should see the main process and one blocking
   client per worker.
3. Watch the `bull:<queue>:wait` keyspace during normal load. It should rise
   and fall, not climb monotonically.
4. To see the stall signature from #37581, drop the network to the instance
   briefly under load. The connection count falls and the `wait` list stops
   draining, while n8n's own healthchecks stay green. That gap is the whole
   point of watching from this side.
