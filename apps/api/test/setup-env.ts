import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.STORAGE_TYPE = 'memory';

if (!process.env.DB_HOST) {
  process.env.DB_HOST = process.env.TEST_DB_HOST || 'localhost';
}

if (!process.env.DB_PORT) {
  // Default to Valkey port from docker-compose.test.yml (6390 mapped to host)
  process.env.DB_PORT = process.env.TEST_DB_PORT || '6390';
}

if (!process.env.DB_PASSWORD) {
  process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'devpassword';
}

if (!process.env.AI_ENABLED) {
  process.env.AI_ENABLED = 'false';
}

if (!process.env.BETTERDB_DATA_DIR) {
  process.env.BETTERDB_DATA_DIR = mkdtempSync(join(tmpdir(), 'betterdb-test-'));
}

// Disable telemetry during tests
process.env.BETTERDB_TELEMETRY = 'false';

if (!process.env.CLIENT_ANALYTICS_POLL_INTERVAL_MS) {
  process.env.CLIENT_ANALYTICS_POLL_INTERVAL_MS = '1000';
}

if (!process.env.AUDIT_POLL_INTERVAL_MS) {
  process.env.AUDIT_POLL_INTERVAL_MS = '1000';
}

if (!process.env.ANOMALY_POLL_INTERVAL_MS) {
  process.env.ANOMALY_POLL_INTERVAL_MS = '1000';
}

if (!process.env.WORKSPACE_DISABLED) {
  process.env.WORKSPACE_DISABLED = 'true';
}
