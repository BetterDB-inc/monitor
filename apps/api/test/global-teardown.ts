import { execSync } from 'child_process';
import * as path from 'path';

const COMPOSE_FILE = 'docker-compose.test.yml';
const PROJECT_NAME = 'betterdb-test';

/**
 * Global test teardown - stops test Docker containers after all tests.
 * Only affects test containers (betterdb-test-*), never dev containers.
 */
export default async function globalTeardown() {
  const projectRoot = path.resolve(__dirname, '../../..');
  const skipDocker = process.env.SKIP_DOCKER_SETUP === 'true';
  const keepContainers = process.env.KEEP_TEST_CONTAINERS === 'true';

  if (skipDocker) {
    console.log('Skipping Docker teardown (SKIP_DOCKER_SETUP=true)');
    return;
  }

  if (keepContainers) {
    console.log('Keeping test containers running (KEEP_TEST_CONTAINERS=true)');
    return;
  }

  console.log('\nCleaning up test Docker containers...');

  try {
    execSync(`docker compose -p ${PROJECT_NAME} -f ${COMPOSE_FILE} down --remove-orphans`, {
      cwd: projectRoot,
      stdio: 'inherit',
    });

    console.log('Test Docker containers stopped and removed\n');
  } catch (error) {
    console.error('Failed to stop test Docker containers:', error);
    // Don't throw - we want tests to complete even if cleanup fails
  }
}
