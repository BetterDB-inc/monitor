import { mkdtempSync } from 'fs';
import { join } from 'path';
import { applyConnectionSettings, BLOCKED_KEYS, KEEP_ENV, STUB_ENTITLEMENT_URL } from './test-env';

process.env.STORAGE_TYPE = 'memory';

applyConnectionSettings();

if (!process.env.AI_ENABLED) {
  process.env.AI_ENABLED = 'false';
}

const testTmpDir = process.env.BETTERDB_TEST_TMP_DIR;
if (!testTmpDir) {
  throw new Error('BETTERDB_TEST_TMP_DIR is set by global setup; run jest with that config');
}
process.env.BETTERDB_DATA_DIR = mkdtempSync(join(testTmpDir, 'betterdb-test-data-'));
process.env.MIGRATION_VERDICT_DIR = join(process.env.BETTERDB_DATA_DIR, 'migration-analysis-verdicts');

// Opt out to run against a real entitlement server or in cloud mode:
// BETTERDB_TEST_KEEP_ENV=true CLOUD_MODE=true pnpm test
if (!KEEP_ENV) {
  for (const key of BLOCKED_KEYS) {
    delete process.env[key];
  }
  process.env.ENTITLEMENT_URL = STUB_ENTITLEMENT_URL;
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
