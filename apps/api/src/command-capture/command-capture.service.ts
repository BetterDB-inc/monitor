import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { StoragePort } from '../common/interfaces/storage-port.interface';
import type {
  StoredCommandCaptureSession,
  StoredCommandCaptureRecord,
  CommandCaptureSessionStatus,
} from '@betterdb/shared';
import type {
  CaptureWindowResponse,
  CaptureBatchRequest,
} from '@betterdb/iovalkey-capture';

const DEFAULT_RETENTION_DAYS = 3;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // prune at most once per hour
/** Grace window for in-flight batches sent just before expiry (covers wrapper→Monitor network latency). */
const EXPIRY_GRACE_MS = 5_000;

@Injectable()
export class CommandCaptureService {
  private readonly logger = new Logger(CommandCaptureService.name);
  private lastPruneAt = 0;

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
  ) {}

  // -- Session lifecycle (user-facing) --

  async startSession(input: {
    connectionId: string;
    durationMs: number;
    commandCap?: number;
    createdBy?: string;
  }): Promise<StoredCommandCaptureSession> {
    const existing = await this.storage.getCommandCaptureSessions({
      connectionId: input.connectionId,
      status: 'active',
      limit: 1,
    });

    // Lazily expire any session past its expiresAt
    for (const session of existing) {
      if (session.expiresAt <= Date.now()) {
        await this.storage.updateCommandCaptureSession(session.id, {
          status: 'expired',
        });
      }
    }

    // Re-check for truly active sessions
    const stillActive = await this.storage.getCommandCaptureSessions({
      connectionId: input.connectionId,
      status: 'active',
      limit: 1,
    });
    const live = stillActive.filter((s) => s.expiresAt > Date.now());
    if (live.length > 0) {
      throw new Error(`An active command capture session already exists for connection ${input.connectionId}`);
    }

    const now = Date.now();
    const session: StoredCommandCaptureSession = {
      id: randomUUID(),
      connectionId: input.connectionId,
      status: 'active',
      startedAt: now,
      durationMs: input.durationMs,
      expiresAt: now + input.durationMs,
      commandCap: input.commandCap,
      commandCount: 0,
      createdBy: input.createdBy,
    };

    await this.storage.saveCommandCaptureSession(session);
    this.logger.log(
      `Started command capture session ${session.id} for connection ${input.connectionId} ` +
      `(duration=${input.durationMs}ms, cap=${input.commandCap ?? 'none'})`,
    );
    return session;
  }

  async stopSession(connectionId: string): Promise<StoredCommandCaptureSession | null> {
    const sessions = await this.storage.getCommandCaptureSessions({
      connectionId,
      status: 'active',
      limit: 1,
    });
    const active = sessions.find((s) => s.expiresAt > Date.now());
    if (!active) return null;

    await this.storage.updateCommandCaptureSession(active.id, {
      status: 'stopped',
      stoppedAt: Date.now(),
    });
    this.logger.log(`Stopped command capture session ${active.id}`);
    return { ...active, status: 'stopped', stoppedAt: Date.now() };
  }

  // -- Status read (user-facing) --

  async getActiveSessions(connectionId: string): Promise<StoredCommandCaptureSession[]> {
    const sessions = await this.storage.getCommandCaptureSessions({
      connectionId,
      status: 'active',
      limit: 1,
    });
    // Lazily expire
    const live: StoredCommandCaptureSession[] = [];
    for (const session of sessions) {
      if (session.expiresAt <= Date.now()) {
        await this.storage.updateCommandCaptureSession(session.id, { status: 'expired' });
      } else {
        live.push(session);
      }
    }
    return live;
  }

  // -- Poll (wrapper-facing) --

  async getActiveWindow(connectionId: string): Promise<CaptureWindowResponse> {
    const sessions = await this.storage.getCommandCaptureSessions({
      connectionId,
      status: 'active',
      limit: 1,
    });

    for (const session of sessions) {
      if (session.expiresAt <= Date.now()) {
        await this.storage.updateCommandCaptureSession(session.id, { status: 'expired' });
        continue;
      }
      if (session.commandCap && session.commandCount >= session.commandCap) {
        await this.storage.updateCommandCaptureSession(session.id, { status: 'stopped', stoppedAt: Date.now() });
        continue;
      }
      return {
        active: true,
        maxCommands: session.commandCap,
        maxDurationMs: session.expiresAt - Date.now(),
        expiresAt: session.expiresAt,
      };
    }

    return { active: false };
  }

  // -- Ingest (wrapper-facing) --

  async ingestBatch(connectionId: string, batch: CaptureBatchRequest): Promise<{ accepted: number; dropped: boolean }> {
    const sessions = await this.storage.getCommandCaptureSessions({
      connectionId,
      status: 'active',
      limit: 1,
    });
    const now = Date.now();
    const active = sessions.find((s) => s.expiresAt + EXPIRY_GRACE_MS > now);

    if (!active) {
      this.logger.debug(`Ingest for connection ${connectionId}: no active/unexpired session, discarding ${batch.commands.length} commands`);
      return { accepted: 0, dropped: true };
    }

    // Command cap enforcement — reject if already at cap
    if (active.commandCap && active.commandCount >= active.commandCap) {
      this.logger.debug(`Ingest for connection ${connectionId}: command cap reached (${active.commandCount}/${active.commandCap}), discarding`);
      return { accepted: 0, dropped: true };
    }

    const records: StoredCommandCaptureRecord[] = batch.commands.map((cmd) => ({
      sessionId: active.id,
      connectionId,
      wrapperConnectionId: batch.connectionId,
      name: cmd.name,
      args: cmd.args,
      ts: cmd.ts,
    }));

    const saved = await this.storage.saveCommandCaptureRecords(records);
    await this.storage.updateCommandCaptureSession(active.id, {
      commandCount: active.commandCount + saved,
    });

    // Inline prune, throttled to at most once per PRUNE_INTERVAL_MS
    const pruneNow = Date.now();
    if (pruneNow - this.lastPruneAt > PRUNE_INTERVAL_MS) {
      this.lastPruneAt = pruneNow;
      this.pruneOldRecords().catch((err) =>
        this.logger.warn(`Prune failed: ${(err as Error).message}`),
      );
    }

    return { accepted: saved, dropped: false };
  }

  // -- Retention --

  async pruneOldRecords(retentionDays: number = DEFAULT_RETENTION_DAYS): Promise<{ records: number; sessions: number }> {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const records = await this.storage.pruneOldCommandCaptureRecords(cutoff);
    const sessions = await this.storage.pruneOldCommandCaptureSessions(cutoff);
    return { records, sessions };
  }
}
