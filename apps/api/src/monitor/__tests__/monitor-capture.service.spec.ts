import { ConflictException } from '@nestjs/common';
import { WebhookEventType } from '@betterdb/shared';
import { EventEmitter } from 'events';
import { MemoryAdapter } from '../../storage/adapters/memory.adapter';
import type { ClusterDiscoveryService } from '../../cluster/cluster-discovery.service';
import type { ConnectionRegistry } from '../../connections/connection-registry.service';
import type { WebhookDispatcherService } from '../../webhooks/webhook-dispatcher.service';
import { MonitorSource } from '../capture-writer';
import { MonitorCaptureService, STOP_WAIT_FOR_START_MS } from '../monitor-capture.service';

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

    it('rejects a concurrent startSession for the same connection while the first is still starting', async () => {
      const { service } = makeService();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      service.setCounterSampleReader(async () => {
        await gate;
        return { capturedAt: 1, counters: { total_commands_processed: 1 } };
      });

      const first = service.startSession({ connectionId: CONNECTION_ID });
      await expect(service.startSession({ connectionId: CONNECTION_ID })).rejects.toBeInstanceOf(
        ConflictException,
      );

      release();
      const session = await first;
      expect(session.status).toBe('running');
      const stored = await service.listSessions({ connectionId: CONNECTION_ID });
      expect(stored).toHaveLength(1);

      await service.stopSession(session.id);
    });

    it('releases the reservation when startSession fails', async () => {
      const { service, storage } = makeService();
      jest.spyOn(storage, 'saveCaptureSession').mockRejectedValueOnce(new Error('disk full'));

      await expect(service.startSession({ connectionId: CONNECTION_ID })).rejects.toThrow(
        'disk full',
      );

      const session = await service.startSession({ connectionId: CONNECTION_ID });
      expect(session.status).toBe('running');
      await service.stopSession(session.id);
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

describe('MonitorCaptureService session-boundary counter snapshots', () => {
  function makeReader() {
    let clock = 1_000;
    return jest.fn(async (_connectionId: string, _nodeId?: string) => ({
      capturedAt: (clock += 10),
      counters: { total_commands_processed: clock },
    }));
  }

  function configureCluster(cluster: { discoverNodes: jest.Mock }, ids: string[]) {
    cluster.discoverNodes.mockResolvedValue(
      ids.map((id) => ({
        id,
        address: `${id.toLowerCase()}:6379`,
        role: 'master',
        slots: [],
        healthy: true,
      })),
    );
  }

  it('stores start and end samples for a single session', async () => {
    const { service, storage, source } = makeService();
    const reader = makeReader();
    service.setCounterSampleReader(reader);

    const session = await service.startSession({ connectionId: CONNECTION_ID });
    source.push('1700000000.0 [0 1:1] "PING"');
    await service.stopSession(session.id);

    const persisted = await storage.getCaptureSession(session.id);
    const nodes = persisted?.counterSnapshots?.nodes ?? [];
    expect(nodes).toHaveLength(1);
    expect(nodes[0].nodeId).toBeUndefined();
    expect(nodes[0].start?.capturedAt).toBeLessThan(nodes[0].end?.capturedAt ?? 0);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(reader).toHaveBeenNthCalledWith(1, CONNECTION_ID, undefined);
    expect(reader).toHaveBeenNthCalledWith(2, CONNECTION_ID, undefined);
  });

  it('takes the start sample before MONITOR opens', async () => {
    const { service, source } = makeService();
    const reader = makeReader();
    const factory = jest.fn().mockResolvedValue(source);
    service.setCounterSampleReader(reader);
    service.setMonitorSourceFactory(factory);

    const session = await service.startSession({ connectionId: CONNECTION_ID });
    await service.stopSession(session.id);

    expect(reader.mock.invocationCallOrder[0]).toBeLessThan(factory.mock.invocationCallOrder[0]);
  });

  it('samples the targeted node', async () => {
    const { service, storage, cluster } = makeService();
    cluster.discoverNodes.mockResolvedValueOnce([
      { id: 'node-a', address: 'cluster-1:6379', role: 'master', slots: [], healthy: true },
      { id: 'node-b', address: 'cluster-2:6379', role: 'master', slots: [], healthy: true },
    ]);
    const reader = makeReader();
    service.setCounterSampleReader(reader);

    const session = await service.startSession({
      connectionId: CONNECTION_ID,
      targetNodeId: 'node-b',
    });
    await service.stopSession(session.id);

    expect(reader).toHaveBeenCalledWith(CONNECTION_ID, 'node-b');
    const persisted = await storage.getCaptureSession(session.id);
    expect(persisted?.counterSnapshots?.nodes[0]).toMatchObject({
      nodeId: 'node-b',
      address: 'cluster-2:6379',
    });
  });

  it('stores one entry per primary for fan-out', async () => {
    const { service, storage, cluster } = makeService();
    configureCluster(cluster, ['A', 'B', 'C']);
    const reader = makeReader();
    service.setCounterSampleReader(reader);
    service.setMonitorSourceFactory(async () => new FakeSource());

    const session = await service.startSession({ connectionId: CONNECTION_ID, fanOut: true });
    await service.stopSession(session.id);

    const persisted = await storage.getCaptureSession(session.id);
    const nodes = persisted?.counterSnapshots?.nodes ?? [];
    expect(nodes.map((n) => n.nodeId)).toEqual(['A', 'B', 'C']);
    expect(nodes.every((n) => n.start !== null && n.end !== null)).toBe(true);
    expect(reader).toHaveBeenCalledTimes(6);
  });

  it('marks a fan-out node whose MONITOR open fails as having no end sample', async () => {
    const { service, storage, cluster } = makeService();
    configureCluster(cluster, ['A', 'B']);
    service.setCounterSampleReader(makeReader());
    service.setMonitorSourceFactory(async (_connId, nodeId) => {
      if (nodeId === 'B') throw new Error('connect ECONNREFUSED');
      return new FakeSource();
    });

    const session = await service.startSession({ connectionId: CONNECTION_ID, fanOut: true });
    await service.stopSession(session.id);

    const persisted = await storage.getCaptureSession(session.id);
    const byId = Object.fromEntries(
      (persisted?.counterSnapshots?.nodes ?? []).map((n) => [n.nodeId, n]),
    );
    expect(byId.B.start).not.toBeNull();
    expect(byId.B.end).toBeNull();
    expect(byId.B.endError).toBe('no_end_sample');
    expect(byId.A.end).not.toBeNull();
    expect(persisted?.status).toBe('failed');
  });

  it('never blocks a capture when the reader fails', async () => {
    const { service, storage } = makeService();
    service.setCounterSampleReader(jest.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const session = await service.startSession({ connectionId: CONNECTION_ID });
    await service.stopSession(session.id);

    const persisted = await storage.getCaptureSession(session.id);
    expect(persisted?.status).toBe('completed');
    expect(persisted?.counterSnapshots?.nodes[0]).toMatchObject({
      start: null,
      startError: 'ECONNREFUSED',
      end: null,
      endError: 'ECONNREFUSED',
    });
  });

  it('bounds a hung reader', async () => {
    const { service, storage } = makeService();
    service.setCounterSampleReader(() => new Promise(() => undefined));

    const session = await service.startSession({ connectionId: CONNECTION_ID });
    await service.stopSession(session.id);

    const persisted = await storage.getCaptureSession(session.id);
    expect(persisted?.counterSnapshots?.nodes[0].startError).toMatch(/timed out after 2000 ms/);
  }, 10_000);

  it('fails open with the default reader when the registry has no client', async () => {
    const { service, storage } = makeService();

    const session = await service.startSession({ connectionId: CONNECTION_ID });
    await service.stopSession(session.id);

    const persisted = await storage.getCaptureSession(session.id);
    expect(persisted?.status).toBe('completed');
    expect(typeof persisted?.counterSnapshots?.nodes[0].startError).toBe('string');
  });

  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  it('rejects a concurrent startSession while the first is still opening MONITOR', async () => {
    const { service, source } = makeService();
    service.setCounterSampleReader(makeReader());
    const opening = gate();
    const factory = jest.fn(async () => {
      await opening.promise;
      return source;
    });
    service.setMonitorSourceFactory(factory);

    const first = service.startSession({ connectionId: CONNECTION_ID });
    for (let i = 0; i < 50 && factory.mock.calls.length === 0; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(factory).toHaveBeenCalledTimes(1);

    await expect(service.startSession({ connectionId: CONNECTION_ID })).rejects.toBeInstanceOf(
      ConflictException,
    );

    opening.release();
    const session = await first;
    expect(session.status).toBe('running');
    expect(await service.listSessions({ connectionId: CONNECTION_ID })).toHaveLength(1);

    await service.stopSession(session.id);
  });

  it('hasActiveSessionOn is true while a session is starting', async () => {
    const { service } = makeService();
    const sampling = gate();
    service.setCounterSampleReader(async () => {
      await sampling.promise;
      return { capturedAt: 1, counters: { total_commands_processed: 1 } };
    });

    const first = service.startSession({ connectionId: CONNECTION_ID });
    expect(service.hasActiveSessionOn(CONNECTION_ID)).toBe(true);

    sampling.release();
    const session = await first;
    expect(service.hasActiveSessionOn(CONNECTION_ID)).toBe(true);

    await service.stopSession(session.id);
    expect(service.hasActiveSessionOn(CONNECTION_ID)).toBe(false);
  });

  it('records no_end_sample when MONITOR fails to open on a single session', async () => {
    const { service } = makeService();
    service.setCounterSampleReader(makeReader());
    service.setMonitorSourceFactory(async () => {
      throw new Error('boom');
    });

    await expect(service.startSession({ connectionId: CONNECTION_ID })).rejects.toThrow('boom');

    const [persisted] = await service.listSessions({ connectionId: CONNECTION_ID });
    expect(persisted.status).toBe('failed');
    const node = persisted.counterSnapshots?.nodes[0];
    expect(node?.start).toBeTruthy();
    expect(node?.endError).toBe('no_end_sample');
  });
});

describe('MonitorCaptureService stop while starting', () => {
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  async function waitFor(check: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !check(); i++) {
      await new Promise((r) => setImmediate(r));
    }
  }

  it('applies a stop that arrives before MONITOR is open instead of dropping it', async () => {
    const { service, storage, source } = makeService();
    const opening = gate();
    const factory = jest.fn(async () => {
      await opening.promise;
      return source;
    });
    service.setMonitorSourceFactory(factory);

    const starting = service.startSession({ connectionId: CONNECTION_ID, durationMs: 600_000 });
    await waitFor(() => factory.mock.calls.length > 0);
    const [row] = await service.listSessions({ connectionId: CONNECTION_ID });
    expect(row.status).toBe('running');

    const stopping = service.stopSession(row.id);
    opening.release();
    await starting;
    const stopped = await stopping;

    expect(stopped?.status).toBe('completed');
    expect(stopped?.terminationReason).toBe('manual_stop');
    expect(service.hasActiveSessionOn(CONNECTION_ID)).toBe(false);
    expect((await storage.getCaptureSession(row.id))?.endedAt).toBeDefined();
  }, 5_000);

  it('returns after the bounded wait when the open stalls, then stops once it opens', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const { service, storage, source } = makeService();
      const opening = gate();
      const factory = jest.fn(async () => {
        await opening.promise;
        return source;
      });
      service.setMonitorSourceFactory(factory);

      const starting = service.startSession({ connectionId: CONNECTION_ID, durationMs: 600_000 });
      await waitFor(() => factory.mock.calls.length > 0);
      const [row] = await service.listSessions({ connectionId: CONNECTION_ID });

      const stopping = service.stopSession(row.id);
      await jest.advanceTimersByTimeAsync(STOP_WAIT_FOR_START_MS);
      const returned = await stopping;
      expect(returned?.status).toBe('running');

      opening.release();
      await starting;
      await waitFor(() => !service.hasActiveSessionOn(CONNECTION_ID));

      const final = await storage.getCaptureSession(row.id);
      expect(final?.terminationReason).toBe('manual_stop');
      expect(service.hasActiveSessionOn(CONNECTION_ID)).toBe(false);
      expect((service as unknown as { stopRequested: Set<string> }).stopRequested.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  }, 5_000);

  it('returns the failed row when the start it waited on fails', async () => {
    const { service } = makeService();
    const opening = gate();
    const factory = jest.fn(async () => {
      await opening.promise;
      throw new Error('connect ECONNREFUSED');
    });
    service.setMonitorSourceFactory(factory);

    const starting = service.startSession({ connectionId: CONNECTION_ID });
    await waitFor(() => factory.mock.calls.length > 0);
    const [row] = await service.listSessions({ connectionId: CONNECTION_ID });

    const stopping = service.stopSession(row.id);
    opening.release();
    await expect(starting).rejects.toThrow('ECONNREFUSED');
    const stopped = await stopping;
    expect(stopped?.status).toBe('failed');
    expect(service.hasActiveSessionOn(CONNECTION_ID)).toBe(false);
    expect((service as unknown as { stopRequested: Set<string> }).stopRequested.size).toBe(0);
  });

  it('isSessionLive tracks starting, running and stopped sessions', async () => {
    const { service, source } = makeService();
    const opening = gate();
    const factory = jest.fn(async () => {
      await opening.promise;
      return source;
    });
    service.setMonitorSourceFactory(factory);

    const starting = service.startSession({ connectionId: CONNECTION_ID });
    await waitFor(() => factory.mock.calls.length > 0);
    const [row] = await service.listSessions({ connectionId: CONNECTION_ID });
    expect(service.isSessionLive(row.id)).toBe(true);

    opening.release();
    await starting;
    expect(service.isSessionLive(row.id)).toBe(true);

    await service.stopSession(row.id);
    expect(service.isSessionLive(row.id)).toBe(false);
    expect(service.isSessionLive('unknown-session')).toBe(false);
  });

  it('the default reader issues one INFO with no section and records process identity', async () => {
    const info = jest
      .fn()
      .mockResolvedValue(
        '# Server\r\nrun_id:abc\r\nuptime_in_seconds:9\r\n# Stats\r\ntotal_commands_processed:1\r\n',
      );
    const registry = {
      get: jest.fn().mockReturnValue({ getClient: () => ({ info }) }),
    } as unknown as ConnectionRegistry;
    const service = new MonitorCaptureService(
      new MemoryAdapter(),
      registry,
      makeDispatcher() as unknown as WebhookDispatcherService,
      {
        discoverNodes: jest.fn().mockResolvedValue([]),
        getNodeConnection: jest.fn(),
      } as unknown as ClusterDiscoveryService,
    );
    service.setMonitorSourceFactory(async () => new FakeSource());

    const session = await service.startSession({ connectionId: CONNECTION_ID });
    const stopped = await service.stopSession(session.id);

    expect(info).toHaveBeenCalledTimes(2);
    for (const call of info.mock.calls) {
      expect(call).toEqual([]);
    }
    const node = stopped?.counterSnapshots?.nodes[0];
    expect(node?.start).toMatchObject({ runId: 'abc', uptimeSec: 9 });
    expect(node?.end).toMatchObject({ runId: 'abc', uptimeSec: 9 });
  });
});
