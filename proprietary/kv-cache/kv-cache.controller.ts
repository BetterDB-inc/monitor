import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Feature, type KvCacheEngine, type KvCacheFootprintSnapshot, type KvCacheStatus } from '@betterdb/shared';
import { LicenseGuard } from '@proprietary/licenses';
import { RequiresFeature } from '@proprietary/licenses/requires-feature.decorator';
import { ConnectionId } from '@app/common/decorators';
import { ENV_DEFAULT_ID } from '@app/connections/connection-registry.service';
import { CreateKvCacheEngineDto, UpdateKvCacheEngineDto } from './dto/kv-cache-engine.dto';
import { KvCacheEnginesService } from './kv-cache-engines.service';
import { KvCacheFootprintService } from './kv-cache-footprint.service';
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
  ) {}

  @Get('status')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.KV_CACHE_MONITORING)
  @ApiOperation({ summary: 'LMCache detection, latest footprint and linked engines (Pro)' })
  @ApiHeader({ name: 'x-connection-id', required: false })
  getStatus(@ConnectionId() connectionId?: string): Promise<KvCacheStatus> {
    return this.status.getStatus(connectionId || ENV_DEFAULT_ID);
  }

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
}
