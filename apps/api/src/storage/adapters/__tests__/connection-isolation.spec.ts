import { MemoryAdapter } from '../memory.adapter';
import { WebhookEventType, DEFAULT_RETRY_POLICY, DeliveryStatus } from '@betterdb/shared';

describe('Multi-Database Connection Isolation', () => {
  let storage: MemoryAdapter;

  const CONN_A = 'connection-alpha';
  const CONN_B = 'connection-beta';

  beforeEach(async () => {
    storage = new MemoryAdapter();
    await storage.initialize();
  });

  describe('ACL Audit Isolation', () => {
    it('data written to connection A must NOT appear when reading connection B', async () => {
      const entry = {
        id: 0,
        count: 1,
        reason: 'auth',
        context: 'GET',
        object: 'secret-key',
        username: 'admin',
        ageSeconds: 10,
        clientInfo: '127.0.0.1:12345',
        timestampCreated: Math.floor(Date.now() / 1000),
        timestampLastUpdated: Math.floor(Date.now() / 1000),
        capturedAt: Date.now(),
        sourceHost: 'localhost',
        sourcePort: 6379,
      };

      await storage.saveAclEntries([entry], CONN_A);

      // Read from connection B — MUST be empty
      const fromB = await storage.getAclEntries({ connectionId: CONN_B });
      expect(fromB).toHaveLength(0);

      // Read from connection A — MUST have the entry
      const fromA = await storage.getAclEntries({ connectionId: CONN_A });
      expect(fromA).toHaveLength(1);
      expect(fromA[0].username).toBe('admin');

      // Read without connectionId — should return all (backward compat)
      const all = await storage.getAclEntries({});
      expect(all.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Client Snapshot Isolation', () => {
    it('snapshots from connection A must NOT leak to connection B', async () => {
      const snapshot = {
        id: 0,
        clientId: 'client-1',
        addr: '127.0.0.1:12345',
        name: 'app',
        user: 'default',
        db: 0,
        cmd: 'GET',
        age: 100,
        idle: 5,
        flags: 'N',
        sub: 0,
        psub: 0,
        qbuf: 0,
        qbufFree: 32768,
        obl: 0,
        oll: 0,
        omem: 0,
        capturedAt: Date.now(),
        sourceHost: 'localhost',
        sourcePort: 6379,
      };

      await storage.saveClientSnapshot([snapshot], CONN_A);

      const fromB = await storage.getClientSnapshots({ connectionId: CONN_B });
      expect(fromB).toHaveLength(0);

      const fromA = await storage.getClientSnapshots({ connectionId: CONN_A });
      expect(fromA).toHaveLength(1);
      expect(fromA[0].clientId).toBe('client-1');
    });
  });

  describe('SlowLog Isolation', () => {
    it('slowlog entries must be scoped per connection', async () => {
      const entry = {
        id: 1001,
        timestamp: Math.floor(Date.now() / 1000),
        duration: 50000,
        command: ['KEYS', '*'],
        clientAddress: '127.0.0.1:12345',
        clientName: 'app',
        capturedAt: Date.now(),
        sourceHost: 'localhost',
        sourcePort: 6379,
      };

      await storage.saveSlowLogEntries([entry], CONN_A);

      const fromB = await storage.getSlowLogEntries({ connectionId: CONN_B });
      expect(fromB).toHaveLength(0);

      const fromA = await storage.getSlowLogEntries({ connectionId: CONN_A });
      expect(fromA).toHaveLength(1);
      expect(fromA[0].command[0]).toBe('KEYS');
    });
  });

  describe('CommandLog Isolation', () => {
    it('commandlog entries must be scoped per connection', async () => {
      const entry = {
        id: 2001,
        timestamp: Math.floor(Date.now() / 1000),
        duration: 100,
        command: ['SET', 'key', 'value'],
        clientAddress: '127.0.0.1:12345',
        clientName: 'app',
        type: 'slow' as const,
        capturedAt: Date.now(),
        sourceHost: 'localhost',
        sourcePort: 6379,
      };

      await storage.saveCommandLogEntries([entry], CONN_A);

      const fromB = await storage.getCommandLogEntries({ connectionId: CONN_B });
      expect(fromB).toHaveLength(0);

      const fromA = await storage.getCommandLogEntries({ connectionId: CONN_A });
      expect(fromA).toHaveLength(1);
      expect(fromA[0].command[0]).toBe('SET');
    });
  });

  describe('Webhook Isolation', () => {
    it('webhooks created for connection A must NOT fire for connection B events', async () => {
      const webhook = {
        name: 'Alert for A',
        url: 'https://example.com/hook',
        secret: 'test-secret',
        events: [WebhookEventType.ANOMALY_DETECTED, WebhookEventType.INSTANCE_DOWN],
        enabled: true,
        connectionId: CONN_A,
        retryPolicy: DEFAULT_RETRY_POLICY,
      };

      await storage.createWebhook(webhook);

      // Query webhooks for connection B's anomaly event — MUST be empty
      const forB = await storage.getWebhooksByEvent(WebhookEventType.ANOMALY_DETECTED, CONN_B);
      expect(forB).toHaveLength(0);

      // Query for connection A — MUST return the webhook
      const forA = await storage.getWebhooksByEvent(WebhookEventType.ANOMALY_DETECTED, CONN_A);
      expect(forA).toHaveLength(1);
      expect(forA[0].name).toBe('Alert for A');
    });

    it('webhook deliveries must be scoped per connection', async () => {
      const delivery = {
        webhookId: 'wh-1',
        eventType: WebhookEventType.ANOMALY_DETECTED,
        payload: {
          event: WebhookEventType.ANOMALY_DETECTED,
          timestamp: Date.now(),
          data: { test: true },
        },
        status: DeliveryStatus.RETRYING,
        attempts: 1,
        nextRetryAt: Date.now() - 1000, // In the past so it's retriable
        connectionId: CONN_A,
      };

      await storage.createDelivery(delivery);

      // Retriable deliveries for connection B — MUST be empty
      const forB = await storage.getRetriableDeliveries(100, CONN_B);
      expect(forB).toHaveLength(0);

      // Retriable deliveries for connection A — MUST have the delivery
      const forA = await storage.getRetriableDeliveries(100, CONN_A);
      expect(forA).toHaveLength(1);
    });
  });

  describe('Cross-Contamination Stress Test', () => {
    it('interleaved writes to A and B must never cross-contaminate', async () => {
      // Write audit to A
      await storage.saveAclEntries([{
        id: 0,
        count: 1,
        reason: 'auth',
        context: 'GET',
        object: 'keyA',
        username: 'userA',
        ageSeconds: 10,
        clientInfo: '1.1.1.1:1',
        timestampCreated: Math.floor(Date.now() / 1000),
        timestampLastUpdated: Math.floor(Date.now() / 1000),
        capturedAt: Date.now(),
        sourceHost: 'hostA',
        sourcePort: 6379,
      }], CONN_A);

      // Write audit to B
      await storage.saveAclEntries([{
        id: 0,
        count: 1,
        reason: 'command',
        context: 'SET',
        object: 'keyB',
        username: 'userB',
        ageSeconds: 5,
        clientInfo: '2.2.2.2:2',
        timestampCreated: Math.floor(Date.now() / 1000),
        timestampLastUpdated: Math.floor(Date.now() / 1000),
        capturedAt: Date.now(),
        sourceHost: 'hostB',
        sourcePort: 6380,
      }], CONN_B);

      // Write slowlog to A
      await storage.saveSlowLogEntries([{
        id: 1,
        timestamp: Math.floor(Date.now() / 1000),
        duration: 1000,
        command: ['KEYS', '*'],
        clientAddress: '1.1.1.1:1',
        clientName: 'appA',
        capturedAt: Date.now(),
        sourceHost: 'hostA',
        sourcePort: 6379,
      }], CONN_A);

      // Write slowlog to B
      await storage.saveSlowLogEntries([{
        id: 2,
        timestamp: Math.floor(Date.now() / 1000),
        duration: 2000,
        command: ['SCAN', '0'],
        clientAddress: '2.2.2.2:2',
        clientName: 'appB',
        capturedAt: Date.now(),
        sourceHost: 'hostB',
        sourcePort: 6380,
      }], CONN_B);

      // Verify complete isolation
      const auditA = await storage.getAclEntries({ connectionId: CONN_A });
      const auditB = await storage.getAclEntries({ connectionId: CONN_B });
      expect(auditA).toHaveLength(1);
      expect(auditA[0].username).toBe('userA');
      expect(auditB).toHaveLength(1);
      expect(auditB[0].username).toBe('userB');

      const slowA = await storage.getSlowLogEntries({ connectionId: CONN_A });
      const slowB = await storage.getSlowLogEntries({ connectionId: CONN_B });
      expect(slowA).toHaveLength(1);
      expect(slowA[0].command[0]).toBe('KEYS');
      expect(slowB).toHaveLength(1);
      expect(slowB[0].command[0]).toBe('SCAN');
    });
  });

  describe('Prune Isolation', () => {
    const NOW = Date.now();
    const OLD = NOW - 100_000;
    const CUTOFF = NOW - 50_000;

    it('pruneOldSlowLogEntries(cutoff, connectionId) removes only that connection\'s old entries', async () => {
      const makeEntry = (id: number, capturedAt: number) => ({
        id, timestamp: Math.floor(capturedAt / 1000), duration: 1000,
        command: ['GET', 'key'], clientAddress: '127.0.0.1:1', clientName: 'app',
        capturedAt, sourceHost: 'localhost', sourcePort: 6379,
      });

      await storage.saveSlowLogEntries([makeEntry(1, OLD), makeEntry(2, NOW)], CONN_A);
      await storage.saveSlowLogEntries([makeEntry(3, OLD), makeEntry(4, NOW)], CONN_B);

      const pruned = await storage.pruneOldSlowLogEntries(CUTOFF, CONN_A);
      expect(pruned).toBe(1);

      const fromA = await storage.getSlowLogEntries({ connectionId: CONN_A });
      expect(fromA).toHaveLength(1);
      expect(fromA[0].id).toBe(2);

      // CONN_B old entry must be untouched
      const fromB = await storage.getSlowLogEntries({ connectionId: CONN_B });
      expect(fromB).toHaveLength(2);
    });

    it('pruneOldSlowLogEntries(cutoff) without connectionId removes old entries across all connections', async () => {
      const makeEntry = (id: number, capturedAt: number) => ({
        id, timestamp: Math.floor(capturedAt / 1000), duration: 1000,
        command: ['GET', 'key'], clientAddress: '127.0.0.1:1', clientName: 'app',
        capturedAt, sourceHost: 'localhost', sourcePort: 6379,
      });

      await storage.saveSlowLogEntries([makeEntry(1, OLD), makeEntry(2, NOW)], CONN_A);
      await storage.saveSlowLogEntries([makeEntry(3, OLD), makeEntry(4, NOW)], CONN_B);

      const pruned = await storage.pruneOldSlowLogEntries(CUTOFF);
      expect(pruned).toBe(2);

      const fromA = await storage.getSlowLogEntries({ connectionId: CONN_A });
      expect(fromA).toHaveLength(1);
      const fromB = await storage.getSlowLogEntries({ connectionId: CONN_B });
      expect(fromB).toHaveLength(1);
    });

    it('pruneOldClientSnapshots(cutoff, connectionId) removes only that connection\'s old entries', async () => {
      const makeSnapshot = (clientId: string, capturedAt: number) => ({
        id: 0, clientId, addr: '127.0.0.1:1', name: 'app', user: 'default',
        db: 0, cmd: 'GET', age: 100, idle: 5, flags: 'N', sub: 0, psub: 0,
        qbuf: 0, qbufFree: 32768, obl: 0, oll: 0, omem: 0,
        capturedAt, sourceHost: 'localhost', sourcePort: 6379,
      });

      await storage.saveClientSnapshot([makeSnapshot('c1', OLD), makeSnapshot('c2', NOW)], CONN_A);
      await storage.saveClientSnapshot([makeSnapshot('c3', OLD), makeSnapshot('c4', NOW)], CONN_B);

      const pruned = await storage.pruneOldClientSnapshots(CUTOFF, CONN_A);
      expect(pruned).toBe(1);

      const fromA = await storage.getClientSnapshots({ connectionId: CONN_A });
      expect(fromA).toHaveLength(1);
      expect(fromA[0].clientId).toBe('c2');

      const fromB = await storage.getClientSnapshots({ connectionId: CONN_B });
      expect(fromB).toHaveLength(2);
    });

    it('pruneOldEntries(cutoff, connectionId) (ACL) removes only that connection\'s old entries', async () => {
      const makeAcl = (username: string, capturedAt: number) => ({
        id: 0, count: 1, reason: 'auth', context: 'GET', object: 'key',
        username, ageSeconds: 10, clientInfo: '127.0.0.1:1',
        timestampCreated: Math.floor(capturedAt / 1000),
        timestampLastUpdated: Math.floor(capturedAt / 1000),
        capturedAt, sourceHost: 'localhost', sourcePort: 6379,
      });

      await storage.saveAclEntries([makeAcl('userA-old', OLD), makeAcl('userA-new', NOW)], CONN_A);
      await storage.saveAclEntries([makeAcl('userB-old', OLD), makeAcl('userB-new', NOW)], CONN_B);

      const pruned = await storage.pruneOldEntries(CUTOFF, CONN_A);
      expect(pruned).toBe(1);

      const fromA = await storage.getAclEntries({ connectionId: CONN_A });
      expect(fromA).toHaveLength(1);
      expect(fromA[0].username).toBe('userA-new');

      const fromB = await storage.getAclEntries({ connectionId: CONN_B });
      expect(fromB).toHaveLength(2);
    });
  });

  describe('Anomaly Event Isolation', () => {
    it('anomaly events must be scoped per connection', async () => {
      const event = {
        id: 'anomaly-1',
        timestamp: Date.now(),
        metricType: 'connections',
        anomalyType: 'spike',
        severity: 'warning',
        value: 100,
        baseline: 50,
        stdDev: 10,
        zScore: 5,
        threshold: 80,
        message: 'Connection spike detected',
        resolved: false,
        sourceHost: 'localhost',
        sourcePort: 6379,
      };

      await storage.saveAnomalyEvent(event, CONN_A);

      const fromB = await storage.getAnomalyEvents({ connectionId: CONN_B });
      expect(fromB).toHaveLength(0);

      const fromA = await storage.getAnomalyEvents({ connectionId: CONN_A });
      expect(fromA).toHaveLength(1);
      expect(fromA[0].metricType).toBe('connections');
    });
  });
});
