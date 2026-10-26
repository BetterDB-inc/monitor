import type { Pool } from 'pg';

const DEADLOCK_DETECTED = '40P01';
const DROP_ATTEMPTS = 5;

export async function dropSchema(
  pool: Pool,
  schema: string,
  { retryMs = 200 }: { retryMs?: number } = {},
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== DEADLOCK_DETECTED || attempt === DROP_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryMs * attempt));
    }
  }
}
