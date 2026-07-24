import { Controller, Get, Post, Delete, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { KeyAnalyticsService } from './key-analytics.service';
import { LicenseGuard } from '@proprietary/licenses/license.guard';
import { RequiresFeature } from '@proprietary/licenses/requires-feature.decorator';
import { ConnectionId, CONNECTION_ID_HEADER } from '../../apps/api/src/common/decorators';

const MAX_LIMIT = 500;

function safeInt(value: string | undefined, fallback?: number, max?: number): number | undefined {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  if (isNaN(n)) return fallback;
  return max ? Math.min(n, max) : n;
}

@Controller('key-analytics')
export class KeyAnalyticsController {
  constructor(private readonly keyAnalytics: KeyAnalyticsService) { }

  @Get('summary')
  @UseGuards(LicenseGuard)
  @RequiresFeature('keyAnalytics')
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to filter by' })
  async getSummary(
    @ConnectionId() connectionId?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ) {
    const start = startTime ? parseInt(startTime, 10) : undefined;
    const end = endTime ? parseInt(endTime, 10) : undefined;
    return this.keyAnalytics.getSummary(start, end, connectionId);
  }

  @Get('patterns')
  @UseGuards(LicenseGuard)
  @RequiresFeature('keyAnalytics')
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to filter by' })
  async getPatterns(
    @ConnectionId() connectionId?: string,
    @Query('pattern') pattern?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('limit') limit?: string,
  ) {
    return this.keyAnalytics.getPatternSnapshots({
      pattern,
      startTime: startTime ? parseInt(startTime, 10) : undefined,
      endTime: endTime ? parseInt(endTime, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      connectionId,
    });
  }

  @Get('hot-keys')
  @UseGuards(LicenseGuard)
  @RequiresFeature('keyAnalytics')
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to filter by' })
  async getHotKeys(
    @ConnectionId() connectionId?: string,
    @Query('limit') limit?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('latest') latest?: string,
    @Query('oldest') oldest?: string,
  ) {
    return this.keyAnalytics.getHotKeys({
      connectionId,
      limit: safeInt(limit, 50, MAX_LIMIT),
      startTime: safeInt(startTime),
      endTime: safeInt(endTime),
      latest: latest === 'true',
      oldest: oldest === 'true',
    });
  }

  @Get('largest-keys')
  @UseGuards(LicenseGuard)
  @RequiresFeature('keyAnalytics')
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to filter by' })
  async getLargestKeys(
    @ConnectionId() connectionId?: string,
    @Query('limit') limit?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('latest') latest?: string,
    @Query('oldest') oldest?: string,
  ) {
    const wantOldest = oldest === 'true';
    return this.keyAnalytics.getLargestKeys({
      connectionId,
      limit: safeInt(limit, 50, MAX_LIMIT),
      startTime: safeInt(startTime),
      endTime: safeInt(endTime),
      // Default to the latest snapshot unless an explicit time range or oldest is requested.
      latest: wantOldest ? false : latest !== 'false',
      oldest: wantOldest,
    });
  }

  @Get('composite-keys')
  @UseGuards(LicenseGuard)
  @RequiresFeature('keyAnalytics')
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to filter by' })
  async getCompositeKeys(
    @ConnectionId() connectionId?: string,
    @Query('limit') limit?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('latest') latest?: string,
    @Query('oldest') oldest?: string,
  ) {
    const wantOldest = oldest === 'true';
    return this.keyAnalytics.getCompositeKeys({
      connectionId,
      limit: safeInt(limit, 50, MAX_LIMIT),
      startTime: safeInt(startTime),
      endTime: safeInt(endTime),
      // Default to the latest snapshot unless an explicit time range or oldest is requested.
      latest: wantOldest ? false : latest !== 'false',
      oldest: wantOldest,
    });
  }

  @Get('trends')
  @UseGuards(LicenseGuard)
  @RequiresFeature('keyAnalytics')
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to filter by' })
  async getTrends(
    @ConnectionId() connectionId?: string,
    @Query('pattern') pattern?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ) {
    if (!pattern || !startTime || !endTime) {
      throw new Error('pattern, startTime, and endTime are required');
    }
    return this.keyAnalytics.getPatternTrends(pattern, parseInt(startTime, 10), parseInt(endTime, 10), connectionId);
  }

  @Post('collect')
  @UseGuards(LicenseGuard)
  @RequiresFeature('keyAnalytics')
  @HttpCode(HttpStatus.ACCEPTED)
  async triggerCollection(@Query('deep') deep?: string) {
    const fullScan = deep === 'true';
    this.keyAnalytics.triggerCollection(fullScan).catch(() => { });
    return {
      message: `Key analytics ${fullScan ? 'deep-scan ' : ''}collection triggered`,
      status: 'processing',
    };
  }

  @Get('key-sizes')
  @UseGuards(LicenseGuard)
  @RequiresFeature('keyAnalytics')
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to filter by' })
  async getKeySizes(@ConnectionId() connectionId?: string) {
    return this.keyAnalytics.getKeySizes(connectionId);
  }

  @Delete('snapshots')
  @UseGuards(LicenseGuard)
  @RequiresFeature('keyAnalytics')
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to filter by' })
  async clearOldSnapshots(
    @ConnectionId() connectionId?: string,
    @Query('olderThan') olderThan?: string,
  ) {
    const cutoffTimestamp = olderThan
      ? parseInt(olderThan, 10)
      : Date.now() - 7 * 24 * 60 * 60 * 1000; // Default: 7 days ago

    const deleted = await this.keyAnalytics.pruneOldSnapshots(cutoffTimestamp, connectionId);
    return {
      message: `Deleted ${deleted} old snapshots`,
      deletedCount: deleted,
      cutoffTimestamp
    };
  }
}
