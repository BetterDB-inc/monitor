import { execSync } from 'child_process';
import * as path from 'path';

/**
 * Global test setup - starts Docker containers before all tests.
 * This ensures tests have a clean, isolated environment.
 */
export async function setup() {
  const projectRoot = path.resolve(__dirname, '../../../../../..');
  const skipDocker = process.env.SKIP_DOCKER_SETUP === 'true';

  // Set database URL for Prisma - default to public schema for simplicity and compatibility
  if (!process.env.ENTITLEMENT_DATABASE_URL) {
    process.env.ENTITLEMENT_DATABASE_URL = 'postgresql://betterdb:devpassword@localhost:5432/betterdb';
  }

  if (skipDocker) {
    console.log('Skipping Docker setup (SKIP_DOCKER_SETUP=true)');
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

    // Start Postgres container
    console.log('   Starting postgres...');
    execSync('docker compose -f docker-compose.yml up -d postgres', {
      cwd: projectRoot,
      stdio: 'inherit',
    });

    // Wait for postgres to be healthy
    console.log('   Waiting for postgres to be healthy...');
    const maxWaitTime = 60000; // 60 seconds
    const startTime = Date.now();
    let postgresReady = false;

    while (!postgresReady && Date.now() - startTime < maxWaitTime) {
      try {
        const postgresHealth = execSync(
          'docker inspect --format="{{.State.Health.Status}}" betterdb-monitor-postgres 2>/dev/null || echo "none"',
          { encoding: 'utf-8' }
        ).trim();

        if (postgresHealth === 'healthy') {
          postgresReady = true;
          console.log('   Postgres is healthy');
        } else {
          process.stdout.write(`   Waiting... postgres: ${postgresHealth}\r`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (error) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    if (!postgresReady) {
      throw new Error('Postgres did not become healthy within timeout');
    }

    // Apply Prisma migrations/schema to the test database
    console.log('   Applying Prisma schema to test database...');
    execSync('npx prisma db push --force-reset --accept-data-loss', {
      cwd: path.resolve(__dirname, '../../../..'),
      stdio: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: process.env.ENTITLEMENT_DATABASE_URL
      }
    });

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
