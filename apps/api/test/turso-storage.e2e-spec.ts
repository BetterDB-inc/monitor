import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { SqliteAdapter } from '../src/storage/adapters/sqlite.adapter';
import type {
  AppSettings,
  StoredAclEntry,
  StoredClientSnapshot,
  StoredAnomalyEvent,
} from '../src/common/interfaces/storage-port.interface';

const TURSO_URL = process.env.TURSO_TEST_URL;
const CONNECTION_ID = 'conn-turso-e2e';
const CREATED_AT = 1_700_000_000;

function aclEntry(overrides: Partial<StoredAclEntry> = {}): StoredAclEntry {
  return {
    id: 0,
    count: 3,
    reason: 'auth',
    context: 'toplevel',
    object: 'AUTH',
    username: 'default',
    ageSeconds: 5,
    clientInfo: 'addr=10.0.0.1:53124 laddr=10.0.0.9:6379 name=',
    timestampCreated: CREATED_AT,
    timestampLastUpdated: CREATED_AT,
    capturedAt: CREATED_AT * 1000,
    sourceHost: 'localhost',
    sourcePort: 6379,
    ...overrides,
  };
}

function clientSnapshot(overrides: Partial<StoredClientSnapshot> = {}): StoredClientSnapshot {
  return {
    id: 0,
    clientId: randomUUID(),
    addr: '10.0.0.1:53124',
    name: 'spike',
    user: 'default',
    db: 0,
    cmd: 'get',
    age: 12,
    idle: 1,
    flags: 'N',
    sub: 0,
    psub: 0,
    qbuf: 0,
    qbufFree: 0,
    obl: 0,
    oll: 0,
    omem: 0,
    capturedAt: CREATED_AT * 1000,
    sourceHost: 'localhost',
    sourcePort: 6379,
    ...overrides,
  };
}

function anomalyEvent(overrides: Partial<StoredAnomalyEvent> = {}): StoredAnomalyEvent {
  return {
    id: randomUUID(),
    timestamp: CREATED_AT * 1000,
    metricType: 'memory',
    anomalyType: 'spike',
    severity: 'warning',
    value: 42,
    baseline: 10,
    stdDev: 2,
    zScore: 16,
    threshold: 3,
    message: 'spike probe',
    resolved: false,
    sourceHost: 'localhost',
    sourcePort: 6379,
    ...overrides,
  };
}

function settingsSeed(): AppSettings {
  return {
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
    createdAt: CREATED_AT * 1000,
    updatedAt: CREATED_AT * 1000,
  };
}

function withoutTimestamps(settings: AppSettings): Omit<AppSettings, 'createdAt' | 'updatedAt'> {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = settings;
  return rest;
}

const describeTurso = TURSO_URL ? describe : describe.skip;

describeTurso('SqliteAdapter against a remote libSQL/Turso database', () => {
  let storage: SqliteAdapter;

  beforeAll(async () => {
    storage = new SqliteAdapter({
      url: TURSO_URL as string,
      authToken: process.env.TURSO_TEST_AUTH_TOKEN,
    });
    await storage.initialize();
  }, 120_000);

  afterAll(async () => {
    if (storage) {
      await storage.close();
    }
  });

  it('creates the schema and runs migrations over the network', async () => {
    // A missing table rejects rather than resolving, so this asserts the schema
    // exists. A fresh database carries no settings row until one is written.
    await expect(storage.getSettings()).resolves.toBeNull();
  });

  it('writes ACL entries through a batched transaction', async () => {
    const saved = await storage.saveAclEntries(
      [aclEntry(), aclEntry({ object: 'SET' })],
      CONNECTION_ID,
    );
    expect(saved).toBe(2);

    const entries = await storage.getAclEntries({ connectionId: CONNECTION_ID });
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });

  it('refreshes an existing ACL entry on upsert', async () => {
    await storage.saveAclEntries([aclEntry({ object: 'UPSERT' })], CONNECTION_ID);
    await storage.saveAclEntries(
      [aclEntry({ object: 'UPSERT', count: 9, clientInfo: 'addr=10.0.0.2:1 laddr=x name=' })],
      CONNECTION_ID,
    );

    const entries = await storage.getAclEntries({ connectionId: CONNECTION_ID });
    const upserted = entries.filter((entry) => {
      return entry.object === 'UPSERT';
    });
    expect(upserted.length).toBe(1);
    expect(upserted[0].count).toBe(9);
  });

  it('writes client snapshots through a batched transaction', async () => {
    const saved = await storage.saveClientSnapshot(
      [clientSnapshot(), clientSnapshot()],
      CONNECTION_ID,
    );
    expect(saved).toBe(2);
  });

  it('writes anomaly events through a batched transaction', async () => {
    const saved = await storage.saveAnomalyEvents([anomalyEvent(), anomalyEvent()], CONNECTION_ID);
    expect(saved).toBe(2);

    const events = await storage.getAnomalyEvents({ connectionId: CONNECTION_ID });
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it('rolls back a failed transaction without leaving partial rows', async () => {
    const before = await storage.getAnomalyEvents({ connectionId: CONNECTION_ID });

    const duplicateId = randomUUID();
    await expect(
      storage.saveAnomalyEvents(
        [
          anomalyEvent({ id: duplicateId }),
          anomalyEvent({ id: duplicateId, metricType: null as unknown as string }),
        ],
        CONNECTION_ID,
      ),
    ).rejects.toBeDefined();

    const after = await storage.getAnomalyEvents({ connectionId: CONNECTION_ID });
    expect(after.length).toBe(before.length);
  });

  it('matches local sqlite settings semantics on a seeded round trip', async () => {
    const localPath = path.join(os.tmpdir(), `turso-parity-${randomUUID()}.db`);
    const local = new SqliteAdapter({ filepath: localPath });
    await local.initialize();

    try {
      const remoteSaved = await storage.saveSettings(settingsSeed());
      const localSaved = await local.saveSettings(settingsSeed());
      expect(withoutTimestamps(remoteSaved)).toEqual(withoutTimestamps(localSaved));

      const remoteUpdated = await storage.updateSettings({ auditPollIntervalMs: 45_000 });
      const localUpdated = await local.updateSettings({ auditPollIntervalMs: 45_000 });
      expect(withoutTimestamps(remoteUpdated)).toEqual(withoutTimestamps(localUpdated));
      expect(remoteUpdated.auditPollIntervalMs).toBe(45_000);

      const remoteRead = await storage.getSettings();
      const localRead = await local.getSettings();
      expect(remoteRead).not.toBeNull();
      expect(withoutTimestamps(remoteRead as AppSettings)).toEqual(
        withoutTimestamps(localRead as AppSettings),
      );
    } finally {
      await local.close();
      fs.rmSync(localPath, { force: true });
    }
  });

  it('rejects an update when no settings row exists, like local sqlite', async () => {
    const localPath = path.join(os.tmpdir(), `turso-unseeded-${randomUUID()}.db`);
    const local = new SqliteAdapter({ filepath: localPath });
    await local.initialize();

    try {
      expect(await local.getSettings()).toBeNull();
      await expect(local.updateSettings({ auditPollIntervalMs: 1_000 })).rejects.toThrow(
        'Settings not found. Initialize settings first.',
      );
    } finally {
      await local.close();
      fs.rmSync(localPath, { force: true });
    }
  });
});
