import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CaptureNodeSegment, WebhookEventType } from '@betterdb/shared';
import {
  CaptureSessionQueryOptions,
  CaptureSessionSource,
  StoragePort,
  StoredCaptureSession,
} from '../common/interfaces/storage-port.interface';
import { ClusterDiscoveryService } from '../cluster/cluster-discovery.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { CaptureWriter, CaptureWriterResult, MonitorSource } from './capture-writer';
import { createIovalkeyMonitorSource } from './iovalkey-monitor-source';
import {
  CounterSampleOutcome,
  CounterSampleReader,
  buildStartSnapshots,
  counterNodeKey,
  readCounterSample,
  sampleFromInfoText,
  withEndSamples,
} from './capture-counters';

/** Default capture duration if the caller does not specify one. Matches the start-session modal default. */
export const DEFAULT_DURATION_MS = 30_000;

/** Community-tier defaults; overridable per session and via env. PR 24 will resolve from license tier. */
const COMMUNITY_BYTE_CAP = 50 * 1024 * 1024; // 50 MB
const COMMUNITY_LINE_CAP = 5_000_000;

export const DEFAULT_BYTE_CAP = parsePositiveInt(process.env.MONITOR_DEFAULT_BYTE_CAP, COMMUNITY_BYTE_CAP);
export const DEFAULT_LINE_CAP = parsePositiveInt(process.env.MONITOR_DEFAULT_LINE_CAP, COMMUNITY_LINE_CAP);

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return isNaN(n) || n <= 0 ? fallback : n;
}

export interface StartSessionInput {
  connectionId: string;
  durationMs?: number;
  byteCap?: number;
  lineCap?: number;
  source?: CaptureSessionSource;
  triggerId?: string;
  scheduleId?: string;
  requestedBy?: string;
  /** Cluster node id to MONITOR. When set, opens a dedicated connection to that node. Null for non-cluster targets. */
  targetNodeId?: string;
  /**
   * Fan-out: open one MONITOR connection per cluster primary and write into a
   * single logical session. Ignored when the connection is not a cluster.
   * Mutually exclusive with targetNodeId (fan-out covers all primaries).
   */
  fanOut?: boolean;
}

/**
 * Per-writer chunk_index namespace size. Each writer in a fan-out session gets
 * its own [N * NAMESPACE, (N+1) * NAMESPACE) range so that the (sessionId,
 * chunkIndex) PK on capture_chunks does not collide across writers. 10M chunks
 * per writer is far beyond any realistic session.
 */
const CHUNK_INDEX_NAMESPACE = 10_000_000;

interface ActiveSession {
  session: StoredCaptureSession;
  /** For single-node sessions this is one writer. For fan-out, one per node. */
  writers: ActiveWriter[];
  /** Resolves after every writer terminates AND the aggregate finalize has run. */
  donePromise: Promise<unknown>;
}

interface ActiveWriter {
  writer: CaptureWriter;
  nodeId?: string;
  address?: string;
}

/**
 * Test seam — overrides how a MonitorSource is created from a connection. The
 * default goes through {@link createIovalkeyMonitorSource}; specs inject a fake.
 * `targetNodeId` is the cluster-discovery node id when the caller wants a
 * specific cluster member instead of the default connection.
 */
export type MonitorSourceFactory = (
  connectionId: string,
  targetNodeId?: string,
) => Promise<MonitorSource>;

@Injectable()
export class MonitorCaptureService {
  private readonly logger = new Logger(MonitorCaptureService.name);
  private readonly active = new Map<string, ActiveSession>();
  private readonly starting = new Set<string>();
  /** Session id → resolves when its startSession call settles (started or failed). */
  private readonly startingById = new Map<string, Promise<void>>();
  private monitorSourceFactory: MonitorSourceFactory;
  private counterSampleReader: CounterSampleReader;

  constructor(
    @Inject('STORAGE_CLIENT')
    private readonly storage: StoragePort,
    private readonly connectionRegistry: ConnectionRegistry,
    private readonly webhookDispatcher: WebhookDispatcherService,
    private readonly clusterDiscovery: ClusterDiscoveryService,
  ) {
    this.monitorSourceFactory = async (connectionId, targetNodeId) => {
      if (targetNodeId) {
        const nodeClient = await this.clusterDiscovery.getNodeConnection(
          targetNodeId,
          connectionId,
        );
        return createIovalkeyMonitorSource(nodeClient);
      }
      const port = this.connectionRegistry.get(connectionId);
      return createIovalkeyMonitorSource(port.getClient());
    };
    this.counterSampleReader = async (connectionId, nodeId) => {
      // Same client selection as the MONITOR source factory, so the INFO
      // sample comes from the node whose traffic is being captured.
      const client = nodeId
        ? await this.clusterDiscovery.getNodeConnection(nodeId, connectionId)
        : this.connectionRegistry.get(connectionId).getClient();
      // Default INFO (no section argument) carries both # Stats and # Server
      // (run_id, uptime_in_seconds, used for restart detection) in one command,
      // on every server version.
      const infoText = await client.info();
      return sampleFromInfoText(infoText, Date.now());
    };
  }

  /** Test seam — overrides the default iovalkey-backed source factory. */
  setMonitorSourceFactory(factory: MonitorSourceFactory): void {
    this.monitorSourceFactory = factory;
  }

  /** Test seam — overrides how session-boundary INFO stats samples are read. */
  setCounterSampleReader(reader: CounterSampleReader): void {
    this.counterSampleReader = reader;
  }

  private sampleCounters(connectionId: string, nodeId?: string): Promise<CounterSampleOutcome> {
    return readCounterSample(this.counterSampleReader, connectionId, nodeId);
  }

  listSessions(options: CaptureSessionQueryOptions = {}): Promise<StoredCaptureSession[]> {
    return this.storage.getCaptureSessions(options);
  }

  getSession(id: string): Promise<StoredCaptureSession | null> {
    return this.storage.getCaptureSession(id);
  }

  /**
   * Start a capture session. Throws ConflictException if another session is
   * already active on the same connection. The returned record reflects the
   * row at insert time (status='running'); poll {@link getSession} for the
   * final state.
   */
  async startSession(input: StartSessionInput): Promise<StoredCaptureSession> {
    const { connectionId } = input;
    if (this.active.has(connectionId) || this.starting.has(connectionId)) {
      throw new ConflictException(
        `A capture session is already active on connection ${connectionId}`,
      );
    }
    this.starting.add(connectionId);
    let startingSessionId: string | undefined;
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });

    try {
      const durationMs = input.durationMs ?? DEFAULT_DURATION_MS;
      const byteCap = input.byteCap ?? DEFAULT_BYTE_CAP;
      const lineCap = input.lineCap ?? DEFAULT_LINE_CAP;

      const fanOutNodes = input.fanOut ? await this.resolveFanOutNodes(connectionId) : [];
      const isFanOut = fanOutNodes.length > 0;

      const targetNode = isFanOut
        ? undefined
        : await this.resolveTargetNodeAddress(connectionId, input.targetNodeId);

      // Start samples are taken before any MONITOR connection opens so the
      // window never includes traffic from before the capture. Fail-open and
      // bounded (2 s per node, in parallel).
      const startTargets = isFanOut
        ? await Promise.all(
            fanOutNodes.map(async (n) => ({
              nodeId: n.id,
              address: n.address,
              outcome: await this.sampleCounters(connectionId, n.id),
            })),
          )
        : [
            {
              nodeId: input.targetNodeId,
              address: targetNode,
              outcome: await this.sampleCounters(connectionId, input.targetNodeId),
            },
          ];

      const initialSegments: CaptureNodeSegment[] = isFanOut
        ? fanOutNodes.map((n) => ({
            nodeId: n.id,
            address: n.address,
            status: 'running',
            byteCount: 0,
            lineCount: 0,
          }))
        : [];

      const session: StoredCaptureSession = {
        id: randomUUID(),
        connectionId,
        status: 'running',
        source: input.source ?? 'manual',
        triggerId: input.triggerId,
        scheduleId: input.scheduleId,
        requestedBy: input.requestedBy,
        startedAt: Date.now(),
        byteCount: 0,
        lineCount: 0,
        byteCap,
        lineCap,
        targetNode,
        nodeSegments: isFanOut ? initialSegments : undefined,
        counterSnapshots: buildStartSnapshots(startTargets),
      };

      // From here the row is visible to clients, so a stop for this id can
      // arrive before MONITOR is open; stopSession waits on `settled`.
      startingSessionId = session.id;
      this.startingById.set(session.id, settled);
      await this.storage.saveCaptureSession(session, connectionId);

      if (isFanOut) {
        return await this.startFanOutSession(session, fanOutNodes, durationMs, byteCap, lineCap);
      }

      return await this.startSingleSession(session, input.targetNodeId, durationMs, byteCap, lineCap);
    } finally {
      this.starting.delete(connectionId);
      if (startingSessionId !== undefined) {
        this.startingById.delete(startingSessionId);
      }
      markSettled();
    }
  }

  private async startSingleSession(
    session: StoredCaptureSession,
    targetNodeId: string | undefined,
    durationMs: number,
    byteCap: number,
    lineCap: number,
  ): Promise<StoredCaptureSession> {
    let monitorSource: MonitorSource;
    try {
      monitorSource = await this.monitorSourceFactory(session.connectionId, targetNodeId);
    } catch (err) {
      this.logger.error(
        `Failed to open MONITOR on ${session.connectionId}: ${(err as Error).message}`,
      );
      await this.storage.updateCaptureSession(session.id, {
        status: 'failed',
        endedAt: Date.now(),
        terminationReason: `monitor_open_failed: ${(err as Error).message}`,
        counterSnapshots: withEndSamples(session.counterSnapshots, new Map()),
      });
      throw err;
    }

    const writer = new CaptureWriter({
      sessionId: session.id,
      source: monitorSource,
      storage: this.storage,
      byteCap,
      lineCap,
      durationMs,
      endSampler: () => this.sampleCounters(session.connectionId, targetNodeId),
      buildFinalizePatch: (endSample) => ({
        counterSnapshots: withEndSamples(
          session.counterSnapshots,
          new Map(endSample === null ? [] : [[counterNodeKey(targetNodeId), endSample]]),
        ),
      }),
    });

    const finalize = writer
      .start()
      .then((result) => this.dispatchSessionEnded(session, result))
      .catch((err: Error) => {
        this.logger.error(`Writer for session ${session.id} threw: ${err.message}`);
      })
      .finally(() => {
        this.active.delete(session.connectionId);
      });

    this.active.set(session.connectionId, {
      session,
      writers: [{ writer }],
      donePromise: finalize,
    });

    void this.dispatchSessionStarted(session);

    return session;
  }

  /**
   * Open one writer per cluster primary; aggregate per-node status into
   * session.nodeSegments. Per-node writer failure does NOT cascade: other
   * writers keep running. The session terminates only after every writer has
   * resolved.
   */
  private async startFanOutSession(
    session: StoredCaptureSession,
    nodes: Array<{ id: string; address: string }>,
    durationMs: number,
    byteCap: number,
    lineCap: number,
  ): Promise<StoredCaptureSession> {
    const writers: ActiveWriter[] = [];
    const segments = new Map<string, CaptureNodeSegment>();
    for (const seg of session.nodeSegments ?? []) {
      segments.set(seg.nodeId, { ...seg });
    }

    const segmentPromises: Array<Promise<void>> = [];
    const endSamples = new Map<string, CounterSampleOutcome>();

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      let source: MonitorSource;
      try {
        source = await this.monitorSourceFactory(session.connectionId, node.id);
      } catch (err) {
        // Failing to open MONITOR on ONE node does not kill the session — mark
        // that segment failed up front and keep going with the others.
        const seg = segments.get(node.id);
        if (seg) {
          seg.status = 'failed';
          seg.endedAt = Date.now();
          seg.terminationReason = `monitor_open_failed: ${(err as Error).message}`;
        }
        this.logger.warn(
          `Fan-out: failed to open MONITOR on ${node.address}: ${(err as Error).message}`,
        );
        continue;
      }

      const writer = new CaptureWriter({
        sessionId: session.id,
        source,
        storage: this.storage,
        byteCap,
        lineCap,
        durationMs,
        nodeId: node.id,
        startChunkIndex: i * CHUNK_INDEX_NAMESPACE,
        skipSessionFinalize: true,
        endSampler: () => this.sampleCounters(session.connectionId, node.id),
      });

      writers.push({ writer, nodeId: node.id, address: node.address });

      segmentPromises.push(
        writer
          .start()
          .then((result) => {
            if (result.endSample) {
              endSamples.set(counterNodeKey(node.id), result.endSample);
            }
            const seg = segments.get(node.id);
            if (!seg) return;
            seg.status = result.status === 'failed' ? 'failed' : result.status;
            seg.endedAt = result.endedAt;
            seg.byteCount = result.byteCount;
            seg.lineCount = result.lineCount;
            seg.terminationReason = result.terminationReason;
          })
          .catch((err: Error) => {
            this.logger.error(
              `Fan-out writer for ${node.address} threw: ${err.message}`,
            );
            const seg = segments.get(node.id);
            if (!seg) return;
            seg.status = 'failed';
            seg.endedAt = Date.now();
            seg.terminationReason = `writer_threw: ${err.message}`;
          }),
      );
    }

    const finalize = Promise.all(segmentPromises)
      .then(() => this.finalizeFanOutSession(session, segments, endSamples))
      .finally(() => {
        this.active.delete(session.connectionId);
      });

    this.active.set(session.connectionId, {
      session,
      writers,
      donePromise: finalize,
    });

    void this.dispatchSessionStarted(session);

    return session;
  }

  private async finalizeFanOutSession(
    session: StoredCaptureSession,
    segments: Map<string, CaptureNodeSegment>,
    endSamples: ReadonlyMap<string, CounterSampleOutcome>,
  ): Promise<void> {
    const segmentList = Array.from(segments.values());
    const totalBytes = segmentList.reduce((s, x) => s + x.byteCount, 0);
    const totalLines = segmentList.reduce((s, x) => s + x.lineCount, 0);
    const endedAt = Math.max(
      ...segmentList.map((s) => s.endedAt ?? Date.now()),
      session.startedAt,
    );

    const status = aggregateSegmentStatus(segmentList);
    const reason = aggregateTerminationReason(segmentList, status);

    try {
      await this.storage.updateCaptureSession(session.id, {
        status,
        endedAt,
        byteCount: totalBytes,
        lineCount: totalLines,
        terminationReason: reason,
        nodeSegments: segmentList,
        counterSnapshots: withEndSamples(session.counterSnapshots, endSamples),
      });
    } catch (err) {
      this.logger.error(`Fan-out finalize failed: ${(err as Error).message}`);
    }

    // status here is one of completed | truncated | failed (segments cannot be
    // 'running' at finalize time); narrow for the dispatch contract.
    const dispatchStatus = status as 'completed' | 'truncated' | 'failed';
    await this.dispatchSessionEnded(session, {
      status: dispatchStatus,
      terminationReason: reason,
      byteCount: totalBytes,
      lineCount: totalLines,
      endedAt,
    });
  }

  /**
   * Aggregate per-node status into a session-level status. The most severe wins:
   * any failed segment → failed; any truncated → truncated; otherwise → completed.
   */

  private async dispatchSessionStarted(session: StoredCaptureSession): Promise<void> {
    try {
      await this.webhookDispatcher.dispatchEvent(
        WebhookEventType.MONITOR_SESSION_STARTED,
        {
          sessionId: session.id,
          source: session.source,
          triggerId: session.triggerId,
          scheduleId: session.scheduleId,
          requestedBy: session.requestedBy,
          startedAt: session.startedAt,
          byteCap: session.byteCap,
          lineCap: session.lineCap,
        },
        session.connectionId,
      );
    } catch (err) {
      this.logger.error(`Failed to dispatch monitor.session.started: ${(err as Error).message}`);
    }
  }

  private async dispatchSessionEnded(
    session: StoredCaptureSession,
    result: CaptureWriterResult,
  ): Promise<void> {
    // 'failed' captures are observability noise more than user-actionable signal
    // and don't have a community webhook; PR 16 will introduce monitor.session.skipped
    // for the related Pro+ case.
    if (result.status === 'failed') return;

    const eventType =
      result.status === 'truncated'
        ? WebhookEventType.MONITOR_SESSION_TRUNCATED
        : WebhookEventType.MONITOR_SESSION_COMPLETED;

    try {
      await this.webhookDispatcher.dispatchEvent(
        eventType,
        {
          sessionId: session.id,
          source: session.source,
          triggerId: session.triggerId,
          scheduleId: session.scheduleId,
          requestedBy: session.requestedBy,
          startedAt: session.startedAt,
          endedAt: result.endedAt,
          durationMs: result.endedAt - session.startedAt,
          byteCount: result.byteCount,
          lineCount: result.lineCount,
          terminationReason: result.terminationReason,
        },
        session.connectionId,
      );
    } catch (err) {
      this.logger.error(`Failed to dispatch ${eventType}: ${(err as Error).message}`);
    }
  }

  /**
   * Stop a running session by ID. If found in the active map, stops every
   * writer (fan-out captures have N) and awaits the aggregate finalize.
   */
  async stopSession(id: string): Promise<StoredCaptureSession | null> {
    // A stop that arrives while the session is still starting (row saved,
    // MONITOR not open yet) waits for the start to settle and then stops it,
    // instead of being dropped and letting the capture run its full duration.
    const starting = this.startingById.get(id);
    if (starting !== undefined) {
      await starting;
    }
    const active = this.findActiveById(id);
    if (active) {
      for (const w of active.writers) {
        w.writer.stop('manual_stop');
      }
      await active.donePromise;
    }
    return this.storage.getCaptureSession(id);
  }

  /**
   * For tail readers (PR 7) — returns a live writer if a session is active.
   * For fan-out sessions returns the first node's writer; the tail panel today
   * shows lines from a single source. Cross-node line interleaving belongs in
   * a follow-up.
   */
  getActiveWriter(connectionId: string): CaptureWriter | undefined {
    return this.active.get(connectionId)?.writers[0]?.writer;
  }

  /** True while a session on the connection is active or still starting. */
  hasActiveSessionOn(connectionId: string): boolean {
    return this.active.has(connectionId) || this.starting.has(connectionId);
  }

  /**
   * True when this process owns the session: it is starting or running here.
   * A row still marked `running` that this returns false for was orphaned
   * (for example the API restarted mid-capture).
   */
  isSessionLive(sessionId: string): boolean {
    return this.startingById.has(sessionId) || this.findActiveById(sessionId) !== undefined;
  }

  private findActiveById(sessionId: string): ActiveSession | undefined {
    for (const a of this.active.values()) {
      if (a.session.id === sessionId) return a;
    }
    return undefined;
  }

  /**
   * Translate a cluster-discovery node id into the human-readable host:port
   * that goes into `capture_sessions.target_node`. Returns undefined for
   * non-cluster sessions and falls back gracefully if discovery fails so a
   * misconfigured cluster client doesn't kill the start path.
   */
  private async resolveTargetNodeAddress(
    connectionId: string,
    targetNodeId: string | undefined,
  ): Promise<string | undefined> {
    if (!targetNodeId) return undefined;
    try {
      const nodes = await this.clusterDiscovery.discoverNodes(connectionId);
      const node = nodes.find((n) => n.id === targetNodeId);
      return node?.address ?? targetNodeId;
    } catch (err) {
      this.logger.warn(`Cluster discovery failed for ${connectionId}: ${(err as Error).message}`);
      return targetNodeId;
    }
  }

  /**
   * Resolve the list of cluster primaries for fan-out. Returns empty when the
   * connection is not a cluster — the caller falls back to a single-node start.
   */
  private async resolveFanOutNodes(
    connectionId: string,
  ): Promise<Array<{ id: string; address: string }>> {
    try {
      const nodes = await this.clusterDiscovery.discoverNodes(connectionId);
      return nodes
        .filter((n) => n.role === 'master' && n.healthy)
        .map((n) => ({ id: n.id, address: n.address }));
    } catch (err) {
      this.logger.warn(
        `Fan-out cluster discovery failed for ${connectionId}: ${(err as Error).message}`,
      );
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Pure aggregation helpers (exported for unit testing)
// ---------------------------------------------------------------------------

export function aggregateSegmentStatus(segments: CaptureNodeSegment[]): StoredCaptureSession['status'] {
  if (segments.length === 0) return 'completed';
  if (segments.some((s) => s.status === 'failed')) return 'failed';
  if (segments.some((s) => s.status === 'truncated')) return 'truncated';
  return 'completed';
}

export function aggregateTerminationReason(
  segments: CaptureNodeSegment[],
  status: StoredCaptureSession['status'],
): string {
  if (status === 'failed') {
    const failed = segments.find((s) => s.status === 'failed');
    return failed?.terminationReason ?? 'fan_out_node_failed';
  }
  if (status === 'truncated') {
    const reasons = new Set(
      segments.filter((s) => s.status === 'truncated').map((s) => s.terminationReason ?? 'truncated'),
    );
    return `fan_out_truncated: ${[...reasons].join(', ')}`;
  }
  return 'fan_out_complete';
}
