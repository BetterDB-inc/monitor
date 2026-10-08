import { execSync } from 'child_process';
import * as path from 'path';

/**
 * Global test setup - starts Docker containers before all tests.
 * This ensures tests have a clean, isolated environment.
 */
// Apply the Prisma schema to ENTITLEMENT_DATABASE_URL. forceReset drops and
// recreates (clean slate) — used when we own the throwaway container; the
// skip-docker path omits it so it doesn't wipe an operator-provided database.
function pushSchema(forceReset: boolean) {
  execSync(`npx prisma db push${forceReset ? ' --force-reset' : ''} --accept-data-loss`, {
    cwd: path.resolve(__dirname, '../../../..'),
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: process.env.ENTITLEMENT_DATABASE_URL },
  });
}

export async function setup() {
  const projectRoot = path.resolve(__dirname, '../../../../../..');
  const skipDocker = process.env.SKIP_DOCKER_SETUP === 'true';

  // Set database URL for Prisma - default to public schema for simplicity and
  // compatibility. POSTGRES_HOST_PORT matches the compose port override so a
  // second checkout can run its own postgres concurrently.
  if (!process.env.ENTITLEMENT_DATABASE_URL) {
    const port = process.env.POSTGRES_HOST_PORT || '5432';
    process.env.ENTITLEMENT_DATABASE_URL = `postgresql://betterdb:devpassword@localhost:${port}/betterdb`;
  }

  if (skipDocker) {
    console.log('Skipping Docker setup (SKIP_DOCKER_SETUP=true)');
    // The schema still has to be applied to the operator-provided database, or
    // tests fail with "relation does not exist". We sync without --force-reset
    // so an existing database isn't dropped — note `db push --accept-data-loss`
    // can still drop columns to match the schema and does NOT reset data, so
    // the operator must point this at a clean/dedicated test database.
    console.log('   Syncing Prisma schema to the existing database...');
    pushSchema(false);
    return;
  }

  console.log('Starting Docker containers for tests...');

  try {
    // Check if Docker is running
    try {
      execSync('docker info', { stdio: 'ignore' });
    } catch (error) {
      console.error('Docker is not running. Please start Docker and try again.');
      throw new Error('Docker daemon is not running');
    }

    // Start Postgres and wait for its healthcheck. The service has no pinned
    // container_name (compose namespaces it per checkout), so address it by
    // service name and let --wait poll the healthcheck.
    console.log('   Starting postgres (compose waits for healthy)...');
    execSync('docker compose -f docker-compose.yml up -d --wait --wait-timeout 60 postgres', {
      cwd: projectRoot,
      stdio: 'inherit',
    });

    // Apply Prisma schema to the throwaway container with a clean slate.
    console.log('   Applying Prisma schema to test database...');
    pushSchema(true);

    console.log('Docker containers and database are ready for testing\n');
  } catch (error) {
    console.error('Failed to setup test environment:', error);
    throw error;
  }
}

export async function teardown() {
  const keepContainers = process.env.KEEP_TEST_CONTAINERS === 'true';
  const skipDocker = process.env.SKIP_DOCKER_SETUP === 'true';

  if (skipDocker || keepContainers) {
    return;
  }

  console.log('\nTeardown complete (Postgres left running for potential other tests)\n');
}
