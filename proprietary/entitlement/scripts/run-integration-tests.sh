#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DB_USER="betterdb"
DB_PASS="devpassword"
DB_NAME="entitlement"

# POSTGRES_HOST_PORT matches the compose port override so a second checkout
# can run its own postgres concurrently.
export ENTITLEMENT_DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:${POSTGRES_HOST_PORT:-5432}/${DB_NAME}"

# The postgres service has no pinned container_name (parallel checkouts would
# conflict on it), so always address it through compose by service name.
compose() {
  docker compose -f "${REPO_ROOT}/docker-compose.yml" "$@"
}

# --- Docker / Postgres ---
# (compose up fails clearly if the daemon is down; no separate precheck needed.)

echo "Ensuring Postgres is up and healthy..."
compose up -d --wait --wait-timeout 60 postgres

# Ensure the entitlement database exists
if ! compose exec -T postgres psql -U "$DB_USER" -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  echo "Creating database '${DB_NAME}'..."
  compose exec -T postgres psql -U "$DB_USER" -c "CREATE DATABASE ${DB_NAME};"
fi

# Schema push is owned by vitest's globalSetup (global-setup.ts), which runs
# `prisma db push --force-reset` against ENTITLEMENT_DATABASE_URL as part of
# the invocation below — pushing here too would just do the work twice.

# --- Run tests ---

echo ""
echo "Running integration tests..."
pnpm vitest run src/entitlement/__tests__/integration/
