import { Controller, Get, Post, Param, Body, Query, HttpException, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
import { VectorSearchService } from './vector-search.service';
import { VectorSearchDto } from './dto/vector-search.dto';
import { ConnectionId } from '../common/decorators';
import { VectorIndexInfo, TextSearchResult, ProfileResult, FieldDistribution } from '../common/types/metrics.types';

@ApiTags('vector-search')
@Controller('vector-search')
export class VectorSearchController {
  constructor(
    private readonly vectorSearchService: VectorSearchService,
  ) {}

  @Get('config')
  @ApiOperation({ summary: 'Get search module configuration' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  async getSearchConfig(@ConnectionId() connectionId?: string): Promise<{ config: Record<string, string> }> {
    try {
      const config = await this.vectorSearchService.getSearchConfig(connectionId);
      return { config };
    } catch (error) {
      throw this.mapError(error, 'Failed to get search config');
    }
  }

  @Get('indexes')
  @ApiOperation({ summary: 'List vector search indexes' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  async getIndexList(@ConnectionId() connectionId?: string): Promise<{ indexes: string[] }> {
    try {
      const indexes = await this.vectorSearchService.getIndexList(connectionId);
      return { indexes };
    } catch (error) {
      throw this.mapError(error, 'Failed to list vector indexes');
    }
  }

  @Get('indexes/:name/keys')
  @ApiOperation({ summary: 'Sample keys from an index', description: 'SCAN for keys matching the index prefix, returning hash fields for each' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  async sampleKeys(
    @Param('name') name: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @ConnectionId() connectionId?: string,
  ) {
    try {
      return await this.vectorSearchService.sampleKeys(
        connectionId,
        name,
        cursor ?? '0',
        limit ? (parseInt(limit, 10) || 50) : 50,
      );
    } catch (error) {
      throw this.mapError(error, 'Failed to sample keys');
    }
  }

  @Get('indexes/:name/snapshots')
  @ApiOperation({ summary: 'Get historical snapshots for a vector index' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  async getSnapshots(
    @Param('name') name: string,
    @Query('hours') hours?: string,
    @ConnectionId() connectionId?: string,
  ) {
    try {
      const h = Math.min(Math.max(parseInt(hours || '24', 10) || 24, 1), 168);
      const snapshots = await this.vectorSearchService.getSnapshots(connectionId, name, h);
      return { snapshots };
    } catch (error) {
      throw this.mapError(error, 'Failed to get index snapshots');
    }
  }

  @Post('indexes/:name/text-search')
  @ApiOperation({ summary: 'Full-text search' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  async textSearch(
    @Param('name') name: string,
    @Body() body: { query: string; offset?: number; limit?: number },
    @ConnectionId() connectionId?: string,
  ): Promise<TextSearchResult> {
    try {
      if (!body.query?.trim()) throw new HttpException('Query is required', HttpStatus.BAD_REQUEST);
      return await this.vectorSearchService.textSearch(connectionId, name, body.query, body.offset, body.limit);
    } catch (error) {
      throw this.mapError(error, 'Text search failed');
    }
  }

  @Get('indexes/:name/fields/:field/tagvals')
  @ApiOperation({ summary: 'Get distinct tag values for a field' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  async getTagValues(
    @Param('name') name: string,
    @Param('field') field: string,
    @ConnectionId() connectionId?: string,
  ): Promise<{ values: string[] }> {
    try {
      const values = await this.vectorSearchService.getTagValues(connectionId, name, field);
      return { values };
    } catch (error) {
      throw this.mapError(error, 'Failed to get tag values');
    }
  }

  @Get('indexes/:name/fields/:field/distribution')
  @ApiOperation({ summary: 'Get field value distribution' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  async getFieldDistribution(
    @Param('name') name: string,
    @Param('field') field: string,
    @Query('type') fieldType?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<FieldDistribution> {
    try {
      return await this.vectorSearchService.getFieldDistribution(connectionId, name, field, fieldType || 'TAG');
    } catch (error) {
      throw this.mapError(error, 'Failed to get field distribution');
    }
  }

  @Post('indexes/:name/profile')
  @ApiOperation({ summary: 'Profile a search query' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  async profileSearch(
    @Param('name') name: string,
    @Body() body: { query: string; limited?: boolean },
    @ConnectionId() connectionId?: string,
  ): Promise<ProfileResult> {
    try {
      if (!body.query?.trim()) throw new HttpException('Query is required', HttpStatus.BAD_REQUEST);
      return await this.vectorSearchService.profileSearch(connectionId, name, body.query, body.limited);
    } catch (error) {
      throw this.mapError(error, 'Profile search failed');
    }
  }

  @Post('indexes/:name/search')
  @ApiOperation({ summary: 'Similarity search', description: 'Find keys similar to a source key using KNN vector search' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  async search(
    @Param('name') name: string,
    @Body() body: VectorSearchDto,
    @ConnectionId() connectionId?: string,
  ) {
    try {
      return await this.vectorSearchService.search(
        connectionId,
        name,
        body.sourceKey,
        body.vectorField,
        body.k ?? 10,
        body.filter,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw this.mapError(error, 'Search failed');
    }
  }

  @Get('indexes/:name')
  @ApiOperation({ summary: 'Get vector index info' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  async getIndexInfo(
    @Param('name') name: string,
    @ConnectionId() connectionId?: string,
  ): Promise<VectorIndexInfo> {
    try {
      return await this.vectorSearchService.getIndexInfo(connectionId, name);
    } catch (error) {
      throw this.mapError(error, 'Failed to get vector index info');
    }
  }

  private mapError(error: unknown, fallback: string): HttpException {
    if (error instanceof HttpException) return error;
    const msg = error instanceof Error ? error.message : 'Unknown error';
    const status = (msg.includes('not available') || msg.includes('not supported'))
      ? HttpStatus.NOT_IMPLEMENTED : HttpStatus.INTERNAL_SERVER_ERROR;
    return new HttpException(`${fallback}: ${msg}`, status);
  }
}
