import { rmSync } from 'fs';

export function removeTestTmpDir(): void {
  try {
    rmSync(process.env.BETTERDB_TEST_TMP_DIR!, { recursive: true, force: true });
  } catch (error) {
    console.error('Failed to remove the test temp dir:', error);
  }
}
