import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AgentTokenGuard } from '../common/guards/agent-token.guard';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { CommandCaptureService } from './command-capture.service';
import type { CaptureBatchRequest, CaptureWindowResponse } from '@betterdb/iovalkey-capture';

/**
 * Wrapper-facing endpoints for iovalkey-capture poll and ingest.
 * Authenticated by the MCP/agent token guard (same as MCP controller).
 * Instance authorization: validates the instanceId exists in the connection
 * registry (matches existing MCP endpoint pattern — tokens are not scoped
 * to specific instances today).
 */
@Controller('api/capture/instance/:instanceId')
@UseGuards(AgentTokenGuard)
export class CommandCaptureController {
  private readonly logger = new Logger(CommandCaptureController.name);

  constructor(
    private readonly captureService: CommandCaptureService,
    private readonly registry: ConnectionRegistry,
  ) {}

  /** Validate instanceId is a known connection. Throws NotFoundException if not. */
  private assertInstanceExists(instanceId: string): void {
    // registry.get() throws NotFoundException if not found
    this.registry.get(instanceId);
  }

  /** Poll: wrapper asks if a capture window is active for this instance. */
  @Get('window')
  async getWindow(
    @Param('instanceId') instanceId: string,
  ): Promise<CaptureWindowResponse> {
    this.assertInstanceExists(instanceId);
    return this.captureService.getActiveWindow(instanceId);
  }

  /** Ingest: wrapper posts a batch of captured commands. */
  @Post('batch')
  @HttpCode(200)
  async ingestBatch(
    @Param('instanceId') instanceId: string,
    @Body() body: CaptureBatchRequest,
  ): Promise<{ accepted: number; dropped: boolean }> {
    this.assertInstanceExists(instanceId);
    if (!body || !Array.isArray(body.commands)) {
      throw new BadRequestException('Invalid batch: commands array required');
    }
    return this.captureService.ingestBatch(instanceId, body);
  }
}

/**
 * User-facing endpoints to start/stop command capture sessions.
 * Uses the same auth pattern as the monitor controller.
 */
@Controller('api/command-capture')
export class CommandCaptureAdminController {
  private readonly logger = new Logger(CommandCaptureAdminController.name);

  constructor(private readonly captureService: CommandCaptureService) {}

  /** Get the active command capture session for a connection, or null. */
  @Get('status')
  async status(
    @Query('connectionId') connectionId: string,
  ) {
    if (!connectionId) {
      throw new BadRequestException('connectionId query param is required');
    }
    return this.captureService.getActiveWindow(connectionId);
  }

  /** Get the active session entity with full details (commandCount, etc). */
  @Get('session')
  async session(
    @Query('connectionId') connectionId: string,
  ) {
    if (!connectionId) {
      throw new BadRequestException('connectionId query param is required');
    }
    const sessions = await this.captureService.getActiveSessions(connectionId);
    return sessions[0] ?? null;
  }

  @Post('start')
  async start(
    @Body() body: { connectionId: string; durationMs: number; commandCap?: number; createdBy?: string },
  ) {
    if (!body.connectionId || !body.durationMs) {
      throw new BadRequestException('connectionId and durationMs are required');
    }
    if (body.durationMs <= 0 || body.durationMs > 24 * 60 * 60 * 1000) {
      throw new BadRequestException('durationMs must be between 1 and 86400000 (24h)');
    }
    try {
      return await this.captureService.startSession(body);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  @Post('stop')
  async stop(
    @Body() body: { connectionId: string },
  ) {
    if (!body.connectionId) {
      throw new BadRequestException('connectionId is required');
    }
    const session = await this.captureService.stopSession(body.connectionId);
    if (!session) {
      return { stopped: false, message: 'No active session found' };
    }
    return { stopped: true, session };
  }
}
