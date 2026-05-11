import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { WebhookEventType } from '@betterdb/shared';
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
}

interface ActiveSession {
  session: StoredCaptureSession;
  writer: CaptureWriter;
  donePromise: Promise<unknown>;
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
  private monitorSourceFactory: MonitorSourceFactory;

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
  }

  /** Test seam — overrides the default iovalkey-backed source factory. */
  setMonitorSourceFactory(factory: MonitorSourceFactory): void {
    this.monitorSourceFactory = factory;
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
    if (this.active.has(connectionId)) {
      throw new ConflictException(
        `A capture session is already active on connection ${connectionId}`,
      );
    }

    const durationMs = input.durationMs ?? DEFAULT_DURATION_MS;
    const byteCap = input.byteCap ?? DEFAULT_BYTE_CAP;
    const lineCap = input.lineCap ?? DEFAULT_LINE_CAP;

    const targetNode = await this.resolveTargetNodeAddress(connectionId, input.targetNodeId);

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
    };

    await this.storage.saveCaptureSession(session, connectionId);

    let monitorSource: MonitorSource;
    try {
      monitorSource = await this.monitorSourceFactory(connectionId, input.targetNodeId);
    } catch (err) {
      this.logger.error(
        `Failed to open MONITOR on ${connectionId}: ${(err as Error).message}`,
      );
      await this.storage.updateCaptureSession(session.id, {
        status: 'failed',
        endedAt: Date.now(),
        terminationReason: `monitor_open_failed: ${(err as Error).message}`,
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
    });

    const finalize = writer
      .start()
      .then((result) => this.dispatchSessionEnded(session, result))
      .catch((err: Error) => {
        this.logger.error(`Writer for session ${session.id} threw: ${err.message}`);
      })
      .finally(() => {
        this.active.delete(connectionId);
      });

    this.active.set(connectionId, { session, writer, donePromise: finalize });

    void this.dispatchSessionStarted(session);

    return session;
  }

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
   * Stop a running session by ID. If found in the active map, awaits the
   * writer's finalization. Returns the latest persisted record (or null).
   */
  async stopSession(id: string): Promise<StoredCaptureSession | null> {
    const active = this.findActiveById(id);
    if (active) {
      active.writer.stop('manual_stop');
      await active.donePromise;
    }
    return this.storage.getCaptureSession(id);
  }

  /**
   * For tail readers (PR 7) — returns the live writer if a session is active.
   * Returns undefined for completed sessions; tail readers should fall back to
   * reading persisted chunks.
   */
  getActiveWriter(connectionId: string): CaptureWriter | undefined {
    return this.active.get(connectionId)?.writer;
  }

  hasActiveSessionOn(connectionId: string): boolean {
    return this.active.has(connectionId);
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
}
