import { execFileSync } from 'child_process';
import { Pool } from 'pg';
import type { AppSettings } from '@betterdb/shared';
import { PostgresAdapter } from '../src/storage/adapters/postgres.adapter';
import { dropSchema } from './postgres-test-utils';

const DSN =
  process.env.ANOMALY_DETECTOR_CONFIG_POSTGRES_TEST_DSN ??
  'postgres://betterdb:devpassword@localhost:5433/betterdb';

const SCHEMA = `anomaly_detector_config_${process.pid}_${Date.now()}`;

function postgresRequired(): boolean {
  const flag = process.env.REQUIRE_POSTGRES_TESTS;
  if (flag === 'true') {
    return true;
  }
  if (flag === 'false') {
    return false;
  }
  return process.env.CI === 'true';
}

function isReachable(connectionString: string): boolean {
  const { hostname, port } = new URL(connectionString);
  const probe = `
    const socket = require('net').createConnection({
      host: process.env.PROBE_HOST,
      port: Number(process.env.PROBE_PORT),
    });
    socket.setTimeout(1500);
    socket.on('connect', () => { socket.destroy(); process.exit(0); });
    socket.on('timeout', () => { socket.destroy(); process.exit(1); });
    socket.on('error', () => { process.exit(1); });
  `;
  try {
    execFileSync(process.execPath, ['-e', probe], {
      stdio: 'ignore',
      timeout: 3000,
      env: { ...process.env, PROBE_HOST: hostname, PROBE_PORT: port || '5432' },
    });
    return true;
  } catch {
    return false;
  }
}

const reachable = isReachable(DSN);
const describePostgres = reachable ? describe : describe.skip;

if (reachable === false && postgresRequired() === true) {
  describe('anomaly detector config — postgres (live Postgres required)', () => {
    it('has a reachable PostgreSQL', () => {
      throw new Error(
        `PostgreSQL is required here (CI or REQUIRE_POSTGRES_TESTS=true) but ${new URL(DSN).host} is unreachable`,
      );
    });
  });
}

describePostgres('anomaly detector config — postgres', () => {
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    adapter = new PostgresAdapter({ connectionString: DSN, schema: SCHEMA });
    await adapter.initialize();
  });

  afterAll(async () => {
    await adapter.close();
    const adminPool = new Pool({ connectionString: DSN });
    await dropSchema(adminPool, SCHEMA);
    await adminPool.end();
  });

  it('round-trips a disabled (Infinity) absolute threshold, not null', async () => {
    const now = Date.now();
    const settings: AppSettings = {
      id: 1,
      auditPollIntervalMs: 60_000,
      clientAnalyticsPollIntervalMs: 60_000,
      anomalyPollIntervalMs: 1_000,
      anomalyCacheTtlMs: 3_600_000,
      anomalyPrometheusIntervalMs: 30_000,
      metricForecastingEnabled: true,
      metricForecastingDefaultRollingWindowMs: 21_600_000,
      metricForecastingDefaultAlertThresholdMs: 7_200_000,
      inferenceSlaConfig: {},
      anomalyDetectorConfig: {
        acl_denied: { criticalAbsolute: Number.POSITIVE_INFINITY },
      } as AppSettings['anomalyDetectorConfig'],
      localRetentionDays: null,
      updatedAt: now,
      createdAt: now,
    };

    await adapter.saveSettings(settings);
    expect(
      (await adapter.getSettings())?.anomalyDetectorConfig?.acl_denied?.criticalAbsolute,
    ).toBe(Number.POSITIVE_INFINITY);

    await adapter.updateSettings({ anomalyPollIntervalMs: 2_000 });
    expect(
      (await adapter.getSettings())?.anomalyDetectorConfig?.acl_denied?.criticalAbsolute,
    ).toBe(Number.POSITIVE_INFINITY);
  });
});
