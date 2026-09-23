#!/usr/bin/env sh
# Generates traffic so the dashboards have something to show:
# steady keyspace churn, a few slow commands, and one oversized reply.
set -eu

HOST="${VALKEY_HOST:-127.0.0.1}"
PORT="${VALKEY_PORT:-6379}"
PASS="${VALKEY_PASSWORD:-demopassword}"
CLI="valkey-cli -h ${HOST} -p ${PORT} -a ${PASS} --no-auth-warning"

echo "Seeding keyspace..."
for i in $(seq 1 2000); do
  $CLI SET "demo:key:${i}" "value-${i}" EX 3600 > /dev/null
done

echo "Generating hits and misses..."
for i in $(seq 1 1000); do
  $CLI GET "demo:key:${i}" > /dev/null
  $CLI GET "demo:absent:${i}" > /dev/null
done

echo "Generating slow commands and a large reply..."
$CLI EVAL "local t = 0 for i = 1, 4000000 do t = t + i end return t" 0 > /dev/null
$CLI RPUSH demo:biglist $(seq 1 5000 | tr '\n' ' ') > /dev/null
$CLI LRANGE demo:biglist 0 -1 > /dev/null
$CLI KEYS 'demo:*' > /dev/null

echo "Done. Open http://localhost:3000 and pick a BetterDB dashboard."
