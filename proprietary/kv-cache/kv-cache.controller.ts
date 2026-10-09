import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Feature, type KvCacheEngine, type KvCacheFootprintSnapshot, type KvCacheSamplesResponse, type KvCacheSettings, type KvCacheStatus } from '@betterdb/shared';
import { LicenseGuard } from '@proprietary/licenses';
import { RequiresFeature } from '@proprietary/licenses/requires-feature.decorator';
import { AllowMembers } from '@app/auth/guards/roles.decorator';
import { ConnectionId } from '@app/common/decorators';
import { ENV_DEFAULT_ID } from '@app/connections/connection-registry.service';
import { CreateKvCacheEngineDto, UpdateKvCacheEngineDto } from './dto/kv-cache-engine.dto';
import { UpdateKvCacheSettingsDto } from './dto/kv-cache-settings.dto';
import { KvCacheAlertsService } from './kv-cache-alerts.service';
import { KvCacheEnginesService } from './kv-cache-engines.service';
import { KvCacheFootprintService } from './kv-cache-footprint.service';
import { KvCacheSamplesService } from './kv-cache-samples.service';
import { KvCacheStatusService } from './kv-cache-status.service';

export function parseRange(from: string | undefined, to: string | undefined): { from: number; to: number } {
  const fromMs = Number(from);
  const toMs = Number(to);
  if (!from || !to || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
    throw new BadRequestException('from and to must be millisecond timestamps with from <= to');
  }
  return { from: fromMs, to: toMs };
}

@ApiTags('kv-cache')
@Controller('kv-cache')
export class KvCacheController {
  constructor(
    private readonly status: KvCacheStatusService,
    private readonly footprint: KvCacheFootprintService,
    private readonly engines: KvCacheEnginesService,
    private readonly samples: KvCacheSamplesService,
    private readonly alerts: KvCacheAlertsService,
  ) {}

  @Get('status')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.KV_CACHE_MONITORING)
  @ApiOperation({ summary: 'LMCache detection, latest footprint and linked engines (Pro)' })
  @ApiHeader({ name: 'x-connection-id', required: false })
  getStatus(@ConnectionId() connectionId?: string): Promise<KvCacheStatus> {
    return this.status.getStatus(connectionId || ENV_DEFAULT_ID);
  }

  @AllowMembers()
  @Post('footprint/refresh')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.KV_CACHE_MONITORING)
  @ApiOperation({ summary: 'Collect the LMCache footprint now (Pro)' })
  @ApiHeader({ name: 'x-connection-id', required: false })
  refreshFootprint(@ConnectionId() connectionId?: string): Promise<KvCacheFootprintSnapshot | null> {
    return this.footprint.triggerCollection(connectionId || ENV_DEFAULT_ID);
  }

  @Get('footprint/history')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.KV_CACHE_MONITORING)
  @ApiOperation({ summary: 'Stored LMCache footprint snapshots (Pro)' })
  @ApiQuery({ name: 'from', required: true, type: Number })
  @ApiQuery({ name: 'to', required: true, type: Number })
  @ApiHeader({ name: 'x-connection-id', required: false })
  async getFootprintHistory(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @ConnectionId() connectionId?: string,
  ): Promise<KvCacheFootprintSnapshot[]> {
    const range = parseRange(from, to);
    return this.status.getFootprintHistory(connectionId || ENV_DEFAULT_ID, range.from, range.to);
  }

  @Get('engines/samples')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.KV_CACHE_MONITORING)
  @ApiOperation({ summary: 'Per-minute LMCache token counters and hit rate history (Pro)' })
  @ApiQuery({ name: 'from', required: true, type: Number })
  @ApiQuery({ name: 'to', required: true, type: Number })
  @ApiQuery({ name: 'engineId', required: false, type: String })
  @ApiQuery({ name: 'model', required: false, type: String })
  @ApiHeader({ name: 'x-connection-id', required: false })
  async getSamples(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('engineId') engineId: string | undefined,
    @Query('model') model: string | undefined,
    @ConnectionId() connectionId?: string,
  ): Promise<KvCacheSamplesResponse> {
    const range = parseRange(from, to);
    return this.samples.getSamples(connectionId || ENV_DEFAULT_ID, { ...range, engineId, model });
  }

  @Get('engines')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.KV_CACHE_MONITORING)
  @ApiOperation({ summary: 'List linked LMCache engines (Pro)' })
  @ApiHeader({ name: 'x-connection-id', required: false })
  listEngines(@ConnectionId() connectionId?: string): KvCacheEngine[] {
    return this.engines.list(connectionId || ENV_DEFAULT_ID);
  }

  @Post('engines')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.KV_CACHE_MONITORING)
  @ApiOperation({ summary: 'Link an LMCache engine by scrape URL or OTLP engine id (Pro)' })
  @ApiHeader({ name: 'x-connection-id', required: false })
  createEngine(@Body() dto: CreateKvCacheEngineDto, @ConnectionId() connectionId?: string): Promise<KvCacheEngine> {
    return this.engines.create(connectionId || ENV_DEFAULT_ID, dto);
  }

  @Patch('engines/:id')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.KV_CACHE_MONITORING)
  @ApiOperation({ summary: 'Update a linked LMCache engine (Pro)' })
  @ApiHeader({ name: 'x-connection-id', required: false })
  updateEngine(
    @Param('id') id: string,
    @Body() dto: UpdateKvCacheEngineDto,
    @ConnectionId() connectionId?: string,
  ): Promise<KvCacheEngine> {
    return this.engines.update(connectionId || ENV_DEFAULT_ID, id, dto);
  }

  @Delete('engines/:id')
  @HttpCode(204)
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.KV_CACHE_MONITORING)
  @ApiOperation({ summary: 'Unlink an LMCache engine (Pro)' })
  @ApiHeader({ name: 'x-connection-id', required: false })
  removeEngine(@Param('id') id: string, @ConnectionId() connectionId?: string): Promise<void> {
    return this.engines.remove(connectionId || ENV_DEFAULT_ID, id);
  }

  @Get('settings')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.KV_CACHE_MONITORING)
  @ApiOperation({ summary: 'KV cache alert settings for the connection (Pro)' })
  @ApiHeader({ name: 'x-connection-id', required: false })
  getSettings(@ConnectionId() connectionId?: string): Promise<KvCacheSettings> {
    return this.alerts.getSettings(connectionId || ENV_DEFAULT_ID);
  }

  @Put('settings')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.KV_CACHE_MONITORING)
  @ApiOperation({ summary: 'Update KV cache alert settings for the connection (Pro)' })
  @ApiHeader({ name: 'x-connection-id', required: false })
  updateSettings(@Body() dto: UpdateKvCacheSettingsDto, @ConnectionId() connectionId?: string): Promise<KvCacheSettings> {
    return this.alerts.updateSettings(connectionId || ENV_DEFAULT_ID, dto);
  }
}
