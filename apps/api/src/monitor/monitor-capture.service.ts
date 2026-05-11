import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  CaptureSessionQueryOptions,
  CaptureSessionSource,
  StoragePort,
  StoredCaptureSession,
} from '../common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { CaptureWriter, MonitorSource } from './capture-writer';
import { createIovalkeyMonitorSource } from './iovalkey-monitor-source';

/** Default capture duration if the caller does not specify one. Matches the start-session modal default. */
export const DEFAULT_DURATION_MS = 30_000;

/** Community-tier defaults. PR 24 will resolve these from license tier. */
export const DEFAULT_BYTE_CAP = 50 * 1024 * 1024; // 50 MB
export const DEFAULT_LINE_CAP = 5_000_000;

export interface StartSessionInput {
  connectionId: string;
  durationMs?: number;
  byteCap?: number;
  lineCap?: number;
  source?: CaptureSessionSource;
  triggerId?: string;
  scheduleId?: string;
  requestedBy?: string;
}

interface ActiveSession {
  session: StoredCaptureSession;
  writer: CaptureWriter;
  donePromise: Promise<unknown>;
}

/**
 * Test seam — overrides how a MonitorSource is created from a connection. The
 * default goes through {@link createIovalkeyMonitorSource}; specs inject a fake.
 */
export type MonitorSourceFactory = (connectionId: string) => Promise<MonitorSource>;

@Injectable()
export class MonitorCaptureService {
  private readonly logger = new Logger(MonitorCaptureService.name);
  private readonly active = new Map<string, ActiveSession>();
  private monitorSourceFactory: MonitorSourceFactory;

  constructor(
    @Inject('STORAGE_CLIENT')
    private readonly storage: StoragePort,
    private readonly connectionRegistry: ConnectionRegistry,
  ) {
    this.monitorSourceFactory = (connectionId) => {
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
    };

    await this.storage.saveCaptureSession(session, connectionId);

    let monitorSource: MonitorSource;
    try {
      monitorSource = await this.monitorSourceFactory(connectionId);
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

    const donePromise = writer.start();
    donePromise
      .catch((err: Error) => {
        this.logger.error(`Writer for session ${session.id} threw: ${err.message}`);
      })
      .finally(() => {
        this.active.delete(connectionId);
      });

    this.active.set(connectionId, { session, writer, donePromise });

    return session;
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
}
