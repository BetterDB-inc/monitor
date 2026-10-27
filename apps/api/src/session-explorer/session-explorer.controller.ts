import { Readable } from 'stream';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { Feature } from '@betterdb/shared';
import type {
  SessionDetail,
  SessionListResponse,
  SessionNamespace,
  SessionOversizeResponse,
  SessionPreview,
} from '@betterdb/shared';
import { LicenseGuard } from '@proprietary/licenses';
import { RequiresFeature } from '@proprietary/licenses/requires-feature.decorator';
import { ConnectionId } from '../common/decorators/connection-id.decorator';
import { ENV_DEFAULT_ID } from '../connections/connection-registry.service';
import {
  LiveConnectionGuard,
  UseHeaderConnectionId,
} from '../external-metrics/live-connection.guard';
import { SessionCapture, SessionExplorerService } from './session-explorer.service';

const MAX_FILENAME_ID = 100;

const exportFilename = (sessionId: string): string =>
  `session-${sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, MAX_FILENAME_ID)}.json`;

function* exportChunks({ namespace, keys, detail }: SessionCapture): Generator<string> {
  const header = {
    exportedAt: new Date().toISOString(),
    namespace: { name: namespace.name, pattern: namespace.pattern, preset: namespace.preset },
    sessionId: detail.sessionId,
  };
  yield `${JSON.stringify(header).slice(0, -1)},"keys":[`;
  for (let i = 0; i < keys.length; i++) {
    yield `${i > 0 ? ',' : ''}${JSON.stringify(keys[i])}`;
  }
  yield `],"parsed":${JSON.stringify(detail)}}`;
}

@ApiTags('session-explorer')
@ApiHeader({ name: 'x-connection-id', required: false })
@UseHeaderConnectionId()
@Controller('session-explorer')
export class SessionExplorerController {
  constructor(private readonly service: SessionExplorerService) {}

  @Get('namespaces')
  @ApiOperation({ summary: 'List session namespaces for a connection' })
  listNamespaces(@ConnectionId() connectionId?: string): Promise<SessionNamespace[]> {
    return this.service.listNamespaces(connectionId || ENV_DEFAULT_ID);
  }

  @Post('namespaces')
  @ApiOperation({ summary: 'Create a session namespace' })
  createNamespace(
    @Body() body: unknown,
    @ConnectionId() connectionId?: string,
  ): Promise<SessionNamespace> {
    return this.service.createNamespace(connectionId || ENV_DEFAULT_ID, body);
  }

  @Post('namespaces/preview')
  @HttpCode(200)
  @UseGuards(LiveConnectionGuard)
  @ApiOperation({ summary: 'Parse one sampled key against an unsaved namespace' })
  preview(@Body() body: unknown, @ConnectionId() connectionId?: string): Promise<SessionPreview> {
    return this.service.preview(connectionId || ENV_DEFAULT_ID, body);
  }

  @Put('namespaces/:id')
  @ApiOperation({ summary: 'Update a session namespace' })
  updateNamespace(
    @Param('id') id: string,
    @Body() body: unknown,
    @ConnectionId() connectionId?: string,
  ): Promise<SessionNamespace> {
    return this.service.updateNamespace(connectionId || ENV_DEFAULT_ID, id, body);
  }

  @Delete('namespaces/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a session namespace' })
  deleteNamespace(@Param('id') id: string, @ConnectionId() connectionId?: string): Promise<void> {
    return this.service.deleteNamespace(connectionId || ENV_DEFAULT_ID, id);
  }

  @Get('namespaces/:id/sessions')
  @UseGuards(LiveConnectionGuard)
  @ApiOperation({ summary: 'List sessions stored under a namespace' })
  listSessions(
    @Param('id') id: string,
    @ConnectionId() connectionId?: string,
  ): Promise<SessionListResponse> {
    return this.service.listSessions(connectionId || ENV_DEFAULT_ID, id);
  }

  @Get('namespaces/:id/oversize')
  @UseGuards(LicenseGuard, LiveConnectionGuard)
  @RequiresFeature(Feature.SESSION_OVERSIZE_FLAGS)
  @ApiOperation({ summary: 'Sessions whose memory exceeds the namespace threshold' })
  oversizeSessions(
    @Param('id') id: string,
    @ConnectionId() connectionId?: string,
  ): Promise<SessionOversizeResponse> {
    return this.service.oversizeSessions(connectionId || ENV_DEFAULT_ID, id);
  }

  @Get('namespaces/:id/sessions/:sessionId')
  @UseGuards(LiveConnectionGuard)
  @ApiOperation({ summary: 'Read and parse one session' })
  getSession(
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
    @ConnectionId() connectionId?: string,
  ): Promise<SessionDetail> {
    return this.service.getSession(connectionId || ENV_DEFAULT_ID, id, sessionId);
  }

  @Get('namespaces/:id/sessions/:sessionId/export')
  @UseGuards(LiveConnectionGuard)
  @ApiOperation({ summary: 'Export one session as stored, as a JSON attachment' })
  async exportSession(
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
    @Res({ passthrough: false }) reply: FastifyReply,
    @ConnectionId() connectionId?: string,
  ): Promise<void> {
    const capture = await this.service.captureSession(
      connectionId || ENV_DEFAULT_ID,
      id,
      sessionId,
    );
    await reply
      .status(200)
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="${exportFilename(sessionId)}"`)
      .send(Readable.from(exportChunks(capture)));
  }
}
