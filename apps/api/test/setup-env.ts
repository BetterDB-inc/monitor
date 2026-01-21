process.env.STORAGE_TYPE = 'memory';

if (!process.env.DB_HOST) {
  process.env.DB_HOST = process.env.TEST_DB_HOST || 'localhost';
}

if (!process.env.DB_PORT) {
  process.env.DB_PORT = process.env.TEST_DB_PORT || '6379';
}

if (!process.env.AI_ENABLED) {
  process.env.AI_ENABLED = 'false';
}

if (!process.env.CLIENT_ANALYTICS_POLL_INTERVAL_MS) {
  process.env.CLIENT_ANALYTICS_POLL_INTERVAL_MS = '1000';
}

if (!process.env.AUDIT_POLL_INTERVAL_MS) {
  process.env.AUDIT_POLL_INTERVAL_MS = '1000';
}

if (!process.env.ANOMALY_POLL_INTERVAL_MS) {
  process.env.ANOMALY_POLL_INTERVAL_MS = '1000';
}
