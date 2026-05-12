import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { Feature, StoredCaptureTrigger } from '@betterdb/shared';
import { LicenseGuard } from '@proprietary/licenses';
import { RequiresFeature } from '@proprietary/licenses/requires-feature.decorator';
import { ClusterDiscoveryService } from '../cluster/cluster-discovery.service';
import { StoragePort, StoredCaptureSession } from '../common/interfaces/storage-port.interface';
import { CaptureTriggerRegistry } from './capture-trigger-registry';
import { BaselineWindow, CrossReferenceEngine, CrossReferenceResult } from './cross-reference.engine';
import { HealthGateResult } from './health-gate';
import { HealthGateService } from './health-gate.service';
import {
  CSV_HEADER,
  MonitorLineFilters,
  lineToCsvRow,
  matchesFilters,
  parseMonitorLine,
} from './monitor-line.parser';
import { MonitorCaptureService } from './monitor-capture.service';
import { MonitorDevPreviewGuard } from './monitor-dev-preview.guard';
import { PreflightResult, PreflightService } from './preflight.service';

const VALID_BASELINES = new Set<BaselineWindow>(['6h', '24h', '7d', 'same-hour-last-week']);

interface PreflightRequestBody {
  connectionId?: string;
  durationMs?: number;
}

interface StartSessionRequestBody {
  connectionId?: string;
  durationMs?: number;
  byteCap?: number;
  lineCap?: number;
  requestedBy?: string;
  targetNodeId?: string;
  fanOut?: boolean;
}

interface CreateTriggerRequestBody {
  connectionId?: string;
  metricType?: string;
  anomalyType?: string;
  expiresAt?: number;
  createdBy?: string;
}

export interface MonitorNodeDescriptor {
  id: string;
  address: string;
  role: 'master' | 'replica';
  healthy: boolean;
}

export interface MonitorNodesResponse {
  isCluster: boolean;
  nodes: MonitorNodeDescriptor[];
}

@Controller('monitor')
@UseGuards(MonitorDevPreviewGuard)
export class MonitorController {
  constructor(
    private readonly captureService: MonitorCaptureService,
    private readonly healthGateService: HealthGateService,
    private readonly preflightService: PreflightService,
    private readonly crossReferenceEngine: CrossReferenceEngine,
    private readonly clusterDiscovery: ClusterDiscoveryService,
    private readonly triggerRegistry: CaptureTriggerRegistry,
    @Inject('STORAGE_CLIENT')
    private readonly storage: StoragePort,
  ) {}

  @Get('_ping')
  ping(): { ok: true } {
    return { ok: true };
  }

  @Get('_diag/health-gate')
  async evaluateHealthGate(
    @Query('connectionId') connectionId?: string,
  ): Promise<HealthGateResult> {
    if (!connectionId) {
      throw new BadRequestException('connectionId query parameter is required');
    }
    return this.healthGateService.evaluate(connectionId);
  }

  @Post('sessions/preflight')
  async preflight(@Body() body: PreflightRequestBody): Promise<PreflightResult> {
    if (!body?.connectionId) {
      throw new BadRequestException('connectionId is required in the request body');
    }
    return this.preflightService.run({
      connectionId: body.connectionId,
      durationMs: body.durationMs,
    });
  }

  @Get('sessions')
  listSessions(
    @Query('connectionId') connectionId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<StoredCaptureSession[]> {
    if (!connectionId) {
      throw new BadRequestException('connectionId query parameter is required');
    }
    return this.captureService.listSessions({
      connectionId,
      limit: parsePositiveInt(limit, 100, 1000),
      offset: parsePositiveInt(offset, 0, Number.MAX_SAFE_INTEGER),
    });
  }

  @Post('sessions')
  async startSession(@Body() body: StartSessionRequestBody): Promise<StoredCaptureSession> {
    if (!body?.connectionId) {
      throw new BadRequestException('connectionId is required in the request body');
    }
    return this.captureService.startSession({
      connectionId: body.connectionId,
      durationMs: body.durationMs,
      byteCap: body.byteCap,
      lineCap: body.lineCap,
      requestedBy: body.requestedBy,
      targetNodeId: body.targetNodeId,
      fanOut: body.fanOut,
    });
  }

  @Get('connections/:id/nodes')
  async listConnectionNodes(@Param('id') id: string): Promise<MonitorNodesResponse> {
    try {
      const nodes = await this.clusterDiscovery.discoverNodes(id);
      if (nodes.length === 0) {
        return { isCluster: false, nodes: [] };
      }
      return {
        isCluster: true,
        nodes: nodes.map((n) => ({
          id: n.id,
          address: n.address,
          role: n.role,
          healthy: n.healthy,
        })),
      };
    } catch {
      // Single-instance connections throw when asked for cluster nodes. That's
      // the signal we use to report "not a cluster" rather than a 500.
      return { isCluster: false, nodes: [] };
    }
  }

  @Get('sessions/:id')
  async getSession(@Param('id') id: string): Promise<StoredCaptureSession> {
    const session = await this.captureService.getSession(id);
    if (!session) {
      throw new NotFoundException(`Session ${id} not found`);
    }
    return session;
  }

  @Delete('sessions/:id')
  async stopSession(@Param('id') id: string): Promise<StoredCaptureSession> {
    const session = await this.captureService.stopSession(id);
    if (!session) {
      throw new NotFoundException(`Session ${id} not found`);
    }
    return session;
  }

  @Get('sessions/:id/cross-reference')
  async crossReference(
    @Param('id') id: string,
    @Query('baseline') baseline?: string,
  ): Promise<CrossReferenceResult> {
    const window = (baseline ?? '24h') as BaselineWindow;
    if (!VALID_BASELINES.has(window)) {
      throw new BadRequestException(
        `baseline must be one of 6h, 24h, 7d, same-hour-last-week (got "${baseline}")`,
      );
    }
    const session = await this.captureService.getSession(id);
    if (!session) {
      throw new NotFoundException(`Session ${id} not found`);
    }
    return this.crossReferenceEngine.compute({ sessionId: id, baseline: window });
  }

  @Get('sessions/:id/export')
  async exportSession(
    @Param('id') id: string,
    @Query('format') format: string | undefined,
    @Query('command') command: string | undefined,
    @Query('client') client: string | undefined,
    @Query('key') key: string | undefined,
    @Query('afterTs') afterTsRaw: string | undefined,
    @Query('beforeTs') beforeTsRaw: string | undefined,
    @Res({ passthrough: false }) reply: FastifyReply,
  ): Promise<void> {
    const session = await this.captureService.getSession(id);
    if (!session) {
      throw new NotFoundException(`Session ${id} not found`);
    }

    const fmt = format === 'csv' ? 'csv' : 'json';
    const filters: MonitorLineFilters = {
      command: trimmedOrUndefined(command),
      client: trimmedOrUndefined(client),
      key: cappedKeyFilter(key),
      afterTs: afterTsRaw ? parseInt(afterTsRaw, 10) : undefined,
      beforeTs: beforeTsRaw ? parseInt(beforeTsRaw, 10) : undefined,
    };

    const chunks = await this.storage.getCaptureChunks(id);
    const filename = `monitor-session-${id}.${fmt}`;

    reply
      .status(200)
      .header('content-type', fmt === 'csv' ? 'text/csv; charset=utf-8' : 'application/json')
      .header('content-disposition', `attachment; filename="${filename}"`);

    if (fmt === 'csv') {
      const out: string[] = [CSV_HEADER];
      for (const chunk of chunks) {
        const text = chunk.bytes.toString('utf-8');
        for (const raw of text.split('\n')) {
          if (!raw) continue;
          const parsed = parseMonitorLine(raw);
          if (!parsed || !matchesFilters(parsed, filters)) continue;
          out.push(lineToCsvRow(parsed));
        }
      }
      reply.send(out.join('\n') + '\n');
      return;
    }

    const rows: unknown[] = [];
    for (const chunk of chunks) {
      const text = chunk.bytes.toString('utf-8');
      for (const raw of text.split('\n')) {
        if (!raw) continue;
        const parsed = parseMonitorLine(raw);
        if (!parsed || !matchesFilters(parsed, filters)) continue;
        rows.push({
          ts: parsed.ts,
          tsRaw: parsed.tsRaw,
          db: parsed.db,
          addr: parsed.addr,
          cmd: parsed.cmd,
          args: parsed.args,
          key: parsed.key,
        });
      }
    }
    reply.send({ sessionId: id, count: rows.length, lines: rows });
  }

  @Get('triggers')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.MONITOR_ANOMALY_TRIGGER)
  listTriggers(
    @Query('connectionId') connectionId?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<StoredCaptureTrigger[]> {
    return this.triggerRegistry.listTriggers({
      connectionId,
      status: status as StoredCaptureTrigger['status'] | undefined,
      limit: parsePositiveInt(limit, 100, 1000),
      offset: parsePositiveInt(offset, 0, Number.MAX_SAFE_INTEGER),
    });
  }

  @Post('triggers')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.MONITOR_ANOMALY_TRIGGER)
  async createTrigger(@Body() body: CreateTriggerRequestBody): Promise<StoredCaptureTrigger> {
    if (!body?.connectionId) {
      throw new BadRequestException('connectionId is required');
    }
    if (!body.metricType) {
      throw new BadRequestException('metricType is required');
    }
    if (!body.anomalyType) {
      throw new BadRequestException('anomalyType is required');
    }
    return this.triggerRegistry.createTrigger({
      connectionId: body.connectionId,
      metricType: body.metricType,
      anomalyType: body.anomalyType,
      expiresAt: body.expiresAt,
      createdBy: body.createdBy,
    });
  }

  @Delete('triggers/:id')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.MONITOR_ANOMALY_TRIGGER)
  async cancelTrigger(@Param('id') id: string): Promise<{ cancelled: boolean }> {
    const ok = await this.triggerRegistry.cancelTrigger(id);
    if (!ok) {
      throw new NotFoundException(`Trigger ${id} not found or not cancellable`);
    }
    return { cancelled: true };
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

/** Trim whitespace and treat empty strings as "no filter". */
function trimmedOrUndefined(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Key-glob filters become regular expressions in the parser. Cap the input
 * length so a long pattern packed with `*` wildcards cannot drive
 * catastrophic backtracking against equally long captured keys.
 */
const MAX_KEY_FILTER_LENGTH = 128;

function cappedKeyFilter(raw: string | undefined): string | undefined {
  const trimmed = trimmedOrUndefined(raw);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > MAX_KEY_FILTER_LENGTH) {
    throw new BadRequestException(
      `key filter must be ${MAX_KEY_FILTER_LENGTH} characters or fewer`,
    );
  }
  return trimmed;
}
