#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CONTAINER="betterdb-monitor-postgres"
DB_USER="betterdb"
DB_PASS="devpassword"
DB_NAME="entitlement"

export ENTITLEMENT_DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}"

# --- Docker / Postgres ---

if ! docker info &>/dev/null; then
  echo "ERROR: Docker daemon is not running. Start Docker and try again."
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "Postgres container not running — starting via docker-compose..."
  docker compose -f "${REPO_ROOT}/docker-compose.yml" up -d postgres
  echo "Waiting for Postgres to become healthy..."
  for i in {1..30}; do
    if docker exec "$CONTAINER" pg_isready -U "$DB_USER" &>/dev/null; then
      break
    fi
    sleep 1
  done
fi

# Ensure the entitlement database exists
if ! docker exec "$CONTAINER" psql -U "$DB_USER" -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  echo "Creating database '${DB_NAME}'..."
  docker exec "$CONTAINER" psql -U "$DB_USER" -c "CREATE DATABASE ${DB_NAME};"
fi

# Push schema (idempotent)
echo "Pushing Prisma schema..."
if ! pnpm prisma db push --accept-data-loss 2>&1; then
  echo "WARNING: prisma db push failed (schema may already be up to date)"
fi

# --- Run tests ---

echo ""
echo "Running integration tests..."
pnpm vitest run src/entitlement/__tests__/integration/
