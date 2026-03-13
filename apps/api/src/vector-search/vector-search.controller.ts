import { Controller, Get, Post, Param, Body, Query, HttpException, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
import { VectorSearchService } from './vector-search.service';
import { VectorSearchDto } from './dto/vector-search.dto';
import { ConnectionId } from '../common/decorators';
import { VectorIndexInfo } from '../common/types/metrics.types';

@ApiTags('vector-search')
@Controller('vector-search')
export class VectorSearchController {
  constructor(
    private readonly vectorSearchService: VectorSearchService,
  ) {}

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
