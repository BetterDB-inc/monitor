import { ConflictException } from '@nestjs/common';
import { WebhookEventType } from '@betterdb/shared';
import { EventEmitter } from 'events';
import { MemoryAdapter } from '../../storage/adapters/memory.adapter';
import type { ClusterDiscoveryService } from '../../cluster/cluster-discovery.service';
import type { ConnectionRegistry } from '../../connections/connection-registry.service';
import type { WebhookDispatcherService } from '../../webhooks/webhook-dispatcher.service';
import { MonitorSource } from '../capture-writer';
import { MonitorCaptureService } from '../monitor-capture.service';

class FakeSource extends EventEmitter implements MonitorSource {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
  push(line: string): void {
    this.emit('line', line);
  }
  end(): void {
    this.emit('end');
  }
}

const CONNECTION_ID = 'conn-1';

interface FakeDispatcher {
  dispatchEvent: jest.Mock;
  calls: Array<{ event: WebhookEventType; data: Record<string, unknown>; connectionId?: string }>;
}

function makeDispatcher(): FakeDispatcher {
  const fake: FakeDispatcher = {
    dispatchEvent: jest.fn(),
    calls: [],
  };
  fake.dispatchEvent.mockImplementation(async (event, data, connectionId) => {
    fake.calls.push({ event, data, connectionId });
  });
  return fake;
}

function makeService(): {
  service: MonitorCaptureService;
  storage: MemoryAdapter;
  source: FakeSource;
  dispatcher: FakeDispatcher;
  cluster: { discoverNodes: jest.Mock; getNodeConnection: jest.Mock };
} {
  const storage = new MemoryAdapter();
  const registry = { get: jest.fn() } as unknown as ConnectionRegistry;
  const dispatcher = makeDispatcher();
  const cluster = {
    discoverNodes: jest.fn().mockResolvedValue([]),
    getNodeConnection: jest.fn(),
  };
  const service = new MonitorCaptureService(
    storage,
    registry,
    dispatcher as unknown as WebhookDispatcherService,
    cluster as unknown as ClusterDiscoveryService,
  );
  const source = new FakeSource();
  service.setMonitorSourceFactory(async () => source);
  return { service, storage, source, dispatcher, cluster };
}

describe('MonitorCaptureService', () => {
  describe('startSession', () => {
    it('inserts the session row with status="running" and registers an active session', async () => {
      const { service, storage } = makeService();
      const session = await service.startSession({ connectionId: CONNECTION_ID });

      expect(session.status).toBe('running');
      expect(session.connectionId).toBe(CONNECTION_ID);
      expect(session.source).toBe('manual');
      expect(session.byteCap).toBeGreaterThan(0);
      expect(session.lineCap).toBeGreaterThan(0);
      expect(service.hasActiveSessionOn(CONNECTION_ID)).toBe(true);

      const persisted = await storage.getCaptureSession(session.id);
      expect(persisted).toMatchObject({
        id: session.id,
        connectionId: CONNECTION_ID,
        status: 'running',
        source: 'manual',
      });

      // Drain
      await service.stopSession(session.id);
    });

    it('throws ConflictException when a session is already active on the same connection', async () => {
      const { service } = makeService();
      await service.startSession({ connectionId: CONNECTION_ID });

      await expect(
        service.startSession({ connectionId: CONNECTION_ID }),
      ).rejects.toBeInstanceOf(ConflictException);

      await service.stopSession((await service.listSessions())[0].id);
    });

    it('allows a new session on the same connection after the previous one ends', async () => {
      const { service } = makeService();
      const first = await service.startSession({ connectionId: CONNECTION_ID });
      await service.stopSession(first.id);

      // After stop, the active map is cleared
      expect(service.hasActiveSessionOn(CONNECTION_ID)).toBe(false);

      const second = await service.startSession({ connectionId: CONNECTION_ID });
      expect(second.id).not.toBe(first.id);
      await service.stopSession(second.id);
    });

    it('records target_node when a cluster node id is supplied', async () => {
      const { service, storage, cluster } = makeService();
      cluster.discoverNodes.mockResolvedValueOnce([
        { id: 'node-a', address: 'cluster-1:6379', role: 'master', slots: [], healthy: true },
        { id: 'node-b', address: 'cluster-2:6379', role: 'master', slots: [], healthy: true },
      ]);
      const session = await service.startSession({
        connectionId: CONNECTION_ID,
        targetNodeId: 'node-b',
      });
      const persisted = await storage.getCaptureSession(session.id);
      expect(persisted?.targetNode).toBe('cluster-2:6379');
      await service.stopSession(session.id);
    });

    it('passes targetNodeId through to the monitor source factory', async () => {
      const { service, source } = makeService();
      const factory = jest.fn().mockResolvedValue(source);
      service.setMonitorSourceFactory(factory);
      const session = await service.startSession({
        connectionId: CONNECTION_ID,
        targetNodeId: 'node-a',
      });
      expect(factory).toHaveBeenCalledWith(CONNECTION_ID, 'node-a');
      await service.stopSession(session.id);
    });

    it('falls back to the supplied id when cluster discovery cannot resolve it', async () => {
      const { service, storage, cluster } = makeService();
      cluster.discoverNodes.mockRejectedValueOnce(new Error('not a cluster'));
      const session = await service.startSession({
        connectionId: CONNECTION_ID,
        targetNodeId: 'lost-node',
      });
      const persisted = await storage.getCaptureSession(session.id);
      expect(persisted?.targetNode).toBe('lost-node');
      await service.stopSession(session.id);
    });

    it('respects byteCap / lineCap overrides from the input', async () => {
      const { service, storage } = makeService();
      const session = await service.startSession({
        connectionId: CONNECTION_ID,
        byteCap: 12_345,
        lineCap: 678,
      });
      const persisted = await storage.getCaptureSession(session.id);
      expect(persisted?.byteCap).toBe(12_345);
      expect(persisted?.lineCap).toBe(678);
      await service.stopSession(session.id);
    });

    it('marks the session as failed when the monitor source factory throws', async () => {
      const storage = new MemoryAdapter();
      const registry = { get: jest.fn() } as unknown as ConnectionRegistry;
      const dispatcher = makeDispatcher();
      const cluster = {
        discoverNodes: jest.fn().mockResolvedValue([]),
        getNodeConnection: jest.fn(),
      };
      const service = new MonitorCaptureService(
        storage,
        registry,
        dispatcher as unknown as WebhookDispatcherService,
        cluster as unknown as ClusterDiscoveryService,
      );
      service.setMonitorSourceFactory(async () => {
        throw new Error('NOPERM monitor not allowed');
      });

      await expect(
        service.startSession({ connectionId: CONNECTION_ID }),
      ).rejects.toThrow('NOPERM monitor not allowed');

      // Session row should exist with status='failed' and the reason
      const sessions = await storage.getCaptureSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        status: 'failed',
        terminationReason: expect.stringContaining('monitor_open_failed'),
      });
      // Active map cleared on the failure path
      expect(service.hasActiveSessionOn(CONNECTION_ID)).toBe(false);
    });
  });

  describe('stopSession', () => {
    it('finalizes the session with status="completed" and reason="manual_stop"', async () => {
      const { service, source } = makeService();
      const session = await service.startSession({ connectionId: CONNECTION_ID });
      source.push('one');
      source.push('two');

      const stopped = await service.stopSession(session.id);
      expect(stopped).toMatchObject({
        id: session.id,
        status: 'completed',
        terminationReason: 'manual_stop',
        lineCount: 2,
      });
      expect(service.hasActiveSessionOn(CONNECTION_ID)).toBe(false);
    });

    it('returns the persisted record (or null) for unknown ids without throwing', async () => {
      const { service } = makeService();
      const result = await service.stopSession('00000000-0000-0000-0000-000000000000');
      expect(result).toBeNull();
    });
  });

  describe('getSession', () => {
    it('returns the persisted record', async () => {
      const { service } = makeService();
      const session = await service.startSession({ connectionId: CONNECTION_ID });
      const fetched = await service.getSession(session.id);
      expect(fetched?.id).toBe(session.id);
      await service.stopSession(session.id);
    });

    it('returns null when the session does not exist', async () => {
      const { service } = makeService();
      expect(await service.getSession('11111111-1111-1111-1111-111111111111')).toBeNull();
    });
  });

  describe('fan-out', () => {
    function configureCluster(cluster: { discoverNodes: jest.Mock }, nodes: Array<{ id: string; address: string; role?: 'master' | 'replica'; healthy?: boolean }>) {
      cluster.discoverNodes.mockResolvedValue(
        nodes.map((n) => ({
          id: n.id,
          address: n.address,
          role: n.role ?? 'master',
          slots: [],
          healthy: n.healthy ?? true,
        })),
      );
    }

    it('opens one writer per primary, attributes each chunk to a node, and aggregates segments on terminate', async () => {
      const { service, storage, cluster } = makeService();
      configureCluster(cluster, [
        { id: 'A', address: 'h1:6379' },
        { id: 'B', address: 'h2:6379' },
        { id: 'C', address: 'h3:6379' },
      ]);

      const sources: Record<string, FakeSource> = {};
      service.setMonitorSourceFactory(async (_connId, nodeId) => {
        const src = new FakeSource();
        if (nodeId) sources[nodeId] = src;
        return src;
      });

      const session = await service.startSession({ connectionId: CONNECTION_ID, fanOut: true });
      expect(Object.keys(sources)).toEqual(['A', 'B', 'C']);

      sources.A.push('1700000000.0 [0 1.2.3.4:5] "GET" "k1"');
      sources.A.push('1700000000.1 [0 1.2.3.4:5] "GET" "k2"');
      sources.B.push('1700000000.2 [0 5.6.7.8:9] "SET" "k3" "v"');
      sources.C.push('1700000000.3 [0 9.9.9.9:9] "DEL" "k4"');
      sources.C.push('1700000000.4 [0 9.9.9.9:9] "DEL" "k5"');
      sources.C.push('1700000000.5 [0 9.9.9.9:9] "DEL" "k6"');

      sources.A.end();
      sources.B.end();
      sources.C.end();

      // Wait for fan-out finalize to drain
      await service.stopSession(session.id);

      const persisted = await storage.getCaptureSession(session.id);
      expect(persisted?.status).toBe('completed');
      expect(persisted?.lineCount).toBe(6);
      expect(persisted?.byteCount).toBeGreaterThan(0);
      expect(persisted?.terminationReason).toBe('fan_out_complete');
      const segs = persisted?.nodeSegments ?? [];
      expect(segs).toHaveLength(3);
      const byId = Object.fromEntries(segs.map((s) => [s.nodeId, s]));
      expect(byId.A.lineCount).toBe(2);
      expect(byId.B.lineCount).toBe(1);
      expect(byId.C.lineCount).toBe(3);
      for (const s of segs) {
        expect(s.status).toBe('completed');
        expect(s.endedAt).toBeDefined();
      }

      // Per-node chunk attribution
      const chunks = await storage.getCaptureChunks(session.id);
      const byNode: Record<string, number> = {};
      for (const c of chunks) {
        byNode[c.nodeId ?? '<none>'] = (byNode[c.nodeId ?? '<none>'] ?? 0) + c.lineCount;
      }
      expect(byNode.A).toBe(2);
      expect(byNode.B).toBe(1);
      expect(byNode.C).toBe(3);
    });

    it('marks one node failed while the others complete (partial failure)', async () => {
      const { service, storage, cluster } = makeService();
      configureCluster(cluster, [
        { id: 'A', address: 'h1:6379' },
        { id: 'B', address: 'h2:6379' },
      ]);
      const sources: Record<string, FakeSource> = {};
      service.setMonitorSourceFactory(async (_connId, nodeId) => {
        const src = new FakeSource();
        if (nodeId) sources[nodeId] = src;
        return src;
      });

      const session = await service.startSession({ connectionId: CONNECTION_ID, fanOut: true });
      sources.A.push('1700000000.0 [0 1:1] "PING"');
      sources.B.emit('error', new Error('node B disconnected'));
      sources.A.end();
      await service.stopSession(session.id);

      const persisted = await storage.getCaptureSession(session.id);
      expect(persisted?.status).toBe('failed');
      const segs = persisted?.nodeSegments ?? [];
      const byId = Object.fromEntries(segs.map((s) => [s.nodeId, s]));
      expect(byId.A.status).toBe('completed');
      expect(byId.B.status).toBe('failed');
      expect(byId.B.terminationReason).toContain('source_error');
    });

    it('marks a node failed if its source factory rejects, others continue', async () => {
      const { service, storage, cluster } = makeService();
      configureCluster(cluster, [
        { id: 'A', address: 'h1:6379' },
        { id: 'B', address: 'h2:6379' },
      ]);
      const sources: Record<string, FakeSource> = {};
      service.setMonitorSourceFactory(async (_connId, nodeId) => {
        if (nodeId === 'B') throw new Error('connect ECONNREFUSED');
        const src = new FakeSource();
        if (nodeId) sources[nodeId] = src;
        return src;
      });

      const session = await service.startSession({ connectionId: CONNECTION_ID, fanOut: true });
      sources.A.push('1700000000.0 [0 1:1] "PING"');
      sources.A.end();
      await service.stopSession(session.id);

      const persisted = await storage.getCaptureSession(session.id);
      const segs = persisted?.nodeSegments ?? [];
      const byId = Object.fromEntries(segs.map((s) => [s.nodeId, s]));
      expect(byId.A.status).toBe('completed');
      expect(byId.B.status).toBe('failed');
      expect(byId.B.terminationReason).toContain('monitor_open_failed');
      expect(persisted?.status).toBe('failed');
    });

    it('falls back to a single-node start when the connection is not a cluster', async () => {
      const { service, storage } = makeService();
      // discoverNodes returns [] for non-cluster
      const session = await service.startSession({ connectionId: CONNECTION_ID, fanOut: true });
      expect(session.nodeSegments).toBeUndefined();
      const persisted = await storage.getCaptureSession(session.id);
      expect(persisted?.nodeSegments).toBeUndefined();
      await service.stopSession(session.id);
    });
  });

  describe('getActiveWriter', () => {
    it('returns the live writer while a session is running and undefined after stop', async () => {
      const { service } = makeService();
      const session = await service.startSession({ connectionId: CONNECTION_ID });
      expect(service.getActiveWriter(CONNECTION_ID)).toBeDefined();
      await service.stopSession(session.id);
      expect(service.getActiveWriter(CONNECTION_ID)).toBeUndefined();
    });
  });

  describe('webhook dispatch', () => {
    it('dispatches monitor.session.started after persisting the row, scoped to connectionId', async () => {
      const { service, dispatcher } = makeService();
      const session = await service.startSession({ connectionId: CONNECTION_ID });

      // Allow the void-fired dispatch to flush
      await new Promise((resolve) => setImmediate(resolve));

      const startedCall = dispatcher.calls.find(
        (c) => c.event === WebhookEventType.MONITOR_SESSION_STARTED,
      );
      expect(startedCall).toBeDefined();
      expect(startedCall?.connectionId).toBe(CONNECTION_ID);
      expect(startedCall?.data).toMatchObject({
        sessionId: session.id,
        source: 'manual',
        startedAt: session.startedAt,
        byteCap: session.byteCap,
        lineCap: session.lineCap,
      });

      await service.stopSession(session.id);
    });

    it('dispatches monitor.session.completed when the writer ends naturally', async () => {
      const { service, source, dispatcher } = makeService();
      const session = await service.startSession({ connectionId: CONNECTION_ID });
      source.push('one');
      source.push('two');
      await service.stopSession(session.id);

      const completedCall = dispatcher.calls.find(
        (c) => c.event === WebhookEventType.MONITOR_SESSION_COMPLETED,
      );
      expect(completedCall).toBeDefined();
      expect(completedCall?.data).toMatchObject({
        sessionId: session.id,
        terminationReason: 'manual_stop',
        lineCount: 2,
        durationMs: expect.any(Number),
      });
      expect(
        dispatcher.calls.find((c) => c.event === WebhookEventType.MONITOR_SESSION_TRUNCATED),
      ).toBeUndefined();
    });

    it('dispatches monitor.session.truncated when a cap is hit', async () => {
      const { service, source, dispatcher } = makeService();
      const session = await service.startSession({
        connectionId: CONNECTION_ID,
        byteCap: 50,
      });
      // Two long lines exceed the 50-byte cap
      source.push('a'.repeat(40));
      source.push('b'.repeat(40));
      // Wait for the writer's done-promise to flush (stopSession awaits it for active sessions)
      await service.stopSession(session.id);

      const truncatedCall = dispatcher.calls.find(
        (c) => c.event === WebhookEventType.MONITOR_SESSION_TRUNCATED,
      );
      expect(truncatedCall).toBeDefined();
      expect(truncatedCall?.data.terminationReason).toBe('byte_cap');
      expect(
        dispatcher.calls.find((c) => c.event === WebhookEventType.MONITOR_SESSION_COMPLETED),
      ).toBeUndefined();
    });

    it('does not dispatch when start fails (failed status has no community webhook)', async () => {
      const storage = new MemoryAdapter();
      const registry = { get: jest.fn() } as unknown as ConnectionRegistry;
      const dispatcher = makeDispatcher();
      const cluster = {
        discoverNodes: jest.fn().mockResolvedValue([]),
        getNodeConnection: jest.fn(),
      };
      const service = new MonitorCaptureService(
        storage,
        registry,
        dispatcher as unknown as WebhookDispatcherService,
        cluster as unknown as ClusterDiscoveryService,
      );
      service.setMonitorSourceFactory(async () => {
        throw new Error('boom');
      });

      await expect(service.startSession({ connectionId: CONNECTION_ID })).rejects.toThrow('boom');

      // No started, no completed, no truncated.
      expect(dispatcher.calls).toEqual([]);
    });
  });
});
