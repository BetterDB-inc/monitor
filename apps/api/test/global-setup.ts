import { execSync } from 'child_process';
import * as path from 'path';

const COMPOSE_FILE = 'docker-compose.test.yml';
const PROJECT_NAME = 'betterdb-test';

const CONTAINER_NAMES = [
  'betterdb-test-valkey',
  'betterdb-test-redis',
  'betterdb-test-postgres',
];

/**
 * Global test setup - starts Docker containers before all tests.
 * Uses a separate compose file (docker-compose.test.yml) with dedicated
 * container names and ports so tests never interfere with dev containers.
 */
export default async function globalSetup() {
  const projectRoot = path.resolve(__dirname, '../../..');
  const skipDocker = process.env.SKIP_DOCKER_SETUP === 'true';

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

    // Stop any existing test containers (cleanup from previous failed runs)
    try {
      execSync(`docker compose -p ${PROJECT_NAME} -f ${COMPOSE_FILE} down --remove-orphans`, {
        cwd: projectRoot,
        stdio: 'ignore',
      });
    } catch (error) {
      // Ignore errors if containers don't exist
    }

    // Force remove test containers by name if they still exist
    for (const containerName of CONTAINER_NAMES) {
      try {
        execSync(`docker stop ${containerName} 2>/dev/null || true`, { stdio: 'ignore' });
        execSync(`docker rm ${containerName} 2>/dev/null || true`, { stdio: 'ignore' });
      } catch (error) {
        // Ignore errors
      }
    }

    // Start test Docker containers
    console.log('   Starting valkey, redis, and postgres (test containers)...');
    execSync(
      `docker compose -p ${PROJECT_NAME} -f ${COMPOSE_FILE} up -d valkey redis postgres`,
      {
        cwd: projectRoot,
        stdio: 'inherit',
      },
    );

    // Wait for services to be healthy
    console.log('   Waiting for services to be healthy...');
    const maxWaitTime = 60000; // 60 seconds
    const startTime = Date.now();
    let allHealthy = false;

    while (!allHealthy && Date.now() - startTime < maxWaitTime) {
      try {
        const valkeyHealth = execSync(
          'docker inspect --format="{{.State.Health.Status}}" betterdb-test-valkey 2>/dev/null || echo "none"',
          { encoding: 'utf-8' },
        ).trim();

        const redisHealth = execSync(
          'docker inspect --format="{{.State.Health.Status}}" betterdb-test-redis 2>/dev/null || echo "none"',
          { encoding: 'utf-8' },
        ).trim();

        const postgresHealth = execSync(
          'docker inspect --format="{{.State.Health.Status}}" betterdb-test-postgres 2>/dev/null || echo "none"',
          { encoding: 'utf-8' },
        ).trim();

        const valkeyReady = valkeyHealth === 'healthy';
        const redisReady = redisHealth === 'healthy';
        const postgresReady = postgresHealth === 'healthy';

        if (valkeyReady && redisReady && postgresReady) {
          allHealthy = true;
          console.log('   All services are healthy');
        } else {
          const status = [];
          if (!valkeyReady) status.push(`valkey: ${valkeyHealth}`);
          if (!redisReady) status.push(`redis: ${redisHealth}`);
          if (!postgresReady) status.push(`postgres: ${postgresHealth}`);
          process.stdout.write(`   Waiting... ${status.join(', ')}\r`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (error) {
        // Services might not exist yet, wait
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    if (!allHealthy) {
      throw new Error('Services did not become healthy within timeout');
    }

    // Additional wait for redis to be fully ready
    console.log('   Verifying Redis connectivity...');
    let redisReady = false;
    const redisStartTime = Date.now();
    while (!redisReady && Date.now() - redisStartTime < 10000) {
      try {
        execSync('docker exec betterdb-test-redis redis-cli -a devpassword ping', {
          stdio: 'ignore',
        });
        redisReady = true;
      } catch (error) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    if (!redisReady) {
      throw new Error('Redis did not become ready within timeout');
    }

    console.log('Docker containers are ready for testing\n');
  } catch (error) {
    console.error('Failed to start Docker containers:', error);

    // Show container logs for debugging
    try {
      console.log('\nContainer logs:');
      execSync(`docker compose -p ${PROJECT_NAME} -f ${COMPOSE_FILE} logs --tail=50`, {
        cwd: projectRoot,
        stdio: 'inherit',
      });
    } catch (logError) {
      // Ignore log errors
    }

    throw error;
  }
}
