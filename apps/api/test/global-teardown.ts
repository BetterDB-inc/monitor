import { execSync } from 'child_process';
import * as path from 'path';

/**
 * Global test teardown - stops Docker containers after all tests.
 * This ensures clean shutdown and resource cleanup.
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

  console.log('\nCleaning up Docker containers...');

  try {
    // Stop and remove containers
    execSync('docker compose -f docker-compose.yml down --remove-orphans', {
      cwd: projectRoot,
      stdio: 'inherit',
    });

    console.log('Docker containers stopped and removed\n');
  } catch (error) {
    console.error('Failed to stop Docker containers:', error);
    // Don't throw - we want tests to complete even if cleanup fails
  }
}
