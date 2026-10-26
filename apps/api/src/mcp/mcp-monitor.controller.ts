import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { CaptureSessionStatus, StoredCaptureSession } from '@betterdb/shared';
import { AgentTokenGuard } from '../common/guards/agent-token.guard';
import { BaselineWindow, CrossReferenceEngine, CrossReferenceResult } from '../monitor/cross-reference.engine';
import { MonitorCaptureService } from '../monitor/monitor-capture.service';
import { ValidateInstanceIdPipe, mapMcpError, safeLimit } from './mcp-helpers';

const SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const BASELINE_WINDOWS: ReadonlySet<string> = new Set(['6h', '24h', '7d', 'same-hour-last-week']);
const SESSION_STATUSES: ReadonlySet<string> = new Set(['running', 'completed', 'truncated', 'failed', 'skipped']);
const DEFAULT_SESSION_LIMIT = 20;
const MAX_SESSION_LIMIT = 100;

/** Compact, token-friendly projection of a capture session row for agents. */
export interface McpCaptureSessionSummary {
  id: string;
  status: CaptureSessionStatus;
  source: StoredCaptureSession['source'];
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  lineCount: number;
  byteCount: number;
  terminationReason: string | null;
  targetNode: string | null;
  fanOutNodeCount: number;
  triggerId: string | null;
  scheduleId: string | null;
  requestedBy: string | null;
}

export function toCaptureSessionSummary(session: StoredCaptureSession): McpCaptureSessionSummary {
  return {
    id: session.id,
    status: session.status,
    source: session.source,
    startedAt: session.startedAt,
    endedAt: session.endedAt ?? null,
    durationMs: session.endedAt === undefined ? null : session.endedAt - session.startedAt,
    lineCount: session.lineCount,
    byteCount: session.byteCount,
    terminationReason: session.terminationReason ?? null,
    targetNode: session.targetNode ?? null,
    fanOutNodeCount: session.nodeSegments?.length ?? 0,
    triggerId: session.triggerId ?? null,
    scheduleId: session.scheduleId ?? null,
    requestedBy: session.requestedBy ?? null,
  };
}

/**
 * Read-only MCP access to MONITOR capture sessions. Unlike the REST routes,
 * every lookup is scoped to the instance in the path: a session id from
 * another instance returns 404, so an agent holding one instance id cannot read
 * another instance's capture.
 */
@Controller('mcp')
@UseGuards(AgentTokenGuard)
export class McpMonitorController {
  private readonly logger = new Logger(McpMonitorController.name);

  constructor(
    private readonly captureService: MonitorCaptureService,
    private readonly crossReferenceEngine: CrossReferenceEngine,
  ) {}

  @Get('instance/:id/monitor/sessions')
  async listCaptureSessions(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ): Promise<{ sessions: McpCaptureSessionSummary[] }> {
    const hasStatus = status !== undefined && status !== '';
    if (hasStatus === true && SESSION_STATUSES.has(status) === false) {
      throw new BadRequestException(
        'status must be one of running, completed, truncated, failed, skipped',
      );
    }
    try {
      const sessions = await this.captureService.listSessions({
        connectionId: id,
        status: hasStatus === true ? (status as CaptureSessionStatus) : undefined,
        limit: safeLimit(limit, DEFAULT_SESSION_LIMIT, MAX_SESSION_LIMIT),
      });
      return { sessions: sessions.map(toCaptureSessionSummary) };
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to list capture sessions');
    }
  }

  @Get('instance/:id/monitor/sessions/:sessionId/cross-reference')
  async getCaptureCrossReference(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Param('sessionId') sessionId: string,
    @Query('baseline') baseline?: string,
  ): Promise<CrossReferenceResult> {
    if (SESSION_ID_RE.test(sessionId) === false) {
      throw new BadRequestException('Invalid capture session ID');
    }
    const window = baseline === undefined || baseline === '' ? '24h' : baseline;
    if (BASELINE_WINDOWS.has(window) === false) {
      throw new BadRequestException('baseline must be one of 6h, 24h, 7d, same-hour-last-week');
    }
    try {
      const session = await this.captureService.getSession(sessionId);
      if (session === null || session.connectionId !== id) {
        throw new NotFoundException(`Capture session ${sessionId} not found on instance ${id}`);
      }
      return await this.crossReferenceEngine.compute({
        sessionId,
        baseline: window as BaselineWindow,
      });
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to compute capture cross-reference');
    }
  }
}
