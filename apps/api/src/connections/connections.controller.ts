import { Controller, Get, Post, Delete, Param, Body, HttpException, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { ConnectionRegistry } from './connection-registry.service';
import {
  CreateConnectionDto,
  ConnectionListResponseDto,
  CurrentConnectionResponseDto,
  TestConnectionResponseDto,
  ConnectionIdResponseDto,
  SuccessResponseDto,
} from '../common/dto/connections.dto';

@ApiTags('connections')
@Controller('connections')
export class ConnectionsController {
  constructor(private readonly registry: ConnectionRegistry) {}

  @Get()
  @ApiOperation({
    summary: 'List all database connections with status',
    description: 'Returns all registered connections including their current connection status and capabilities.',
  })
  @ApiResponse({ status: 200, description: 'Returns all connections with their status', type: ConnectionListResponseDto })
  list(): ConnectionListResponseDto {
    return {
      connections: this.registry.list(),
      currentId: this.registry.getDefaultId(),
    };
  }

  @Get('current')
  @ApiOperation({
    summary: 'Get the current default connection ID',
    description: 'Returns the ID of the connection that will be used when no X-Connection-Id header is provided.',
  })
  @ApiResponse({ status: 200, description: 'Returns the current default connection ID', type: CurrentConnectionResponseDto })
  getCurrent(): CurrentConnectionResponseDto {
    return {
      id: this.registry.getDefaultId(),
    };
  }

  @Post()
  @ApiOperation({
    summary: 'Create a new database connection',
    description: 'Creates and tests a new database connection. The connection is validated before being saved.',
  })
  @ApiResponse({ status: 201, description: 'Connection created successfully', type: ConnectionIdResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid connection configuration or connection test failed' })
  async create(@Body() request: CreateConnectionDto): Promise<ConnectionIdResponseDto> {
    try {
      const id = await this.registry.addConnection(request);
      return { id };
    } catch (error) {
      throw new HttpException(
        error instanceof Error ? error.message : 'Failed to create connection',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('test')
  @ApiOperation({
    summary: 'Test a connection without saving',
    description: 'Tests connection parameters and returns capabilities without persisting the connection.',
  })
  @ApiResponse({ status: 200, description: 'Connection test result', type: TestConnectionResponseDto })
  async test(@Body() request: CreateConnectionDto): Promise<TestConnectionResponseDto> {
    return this.registry.testConnection(request);
  }

  @Post(':id/default')
  @ApiOperation({
    summary: 'Set a connection as the default',
    description: 'Sets the specified connection as the default. The default connection is used when no X-Connection-Id header is provided.',
  })
  @ApiParam({ name: 'id', description: 'Connection ID to set as default' })
  @ApiResponse({ status: 200, description: 'Default connection updated', type: SuccessResponseDto })
  @ApiResponse({ status: 404, description: 'Connection not found' })
  async setDefault(@Param('id') id: string): Promise<SuccessResponseDto> {
    try {
      await this.registry.setDefault(id);
      return { success: true };
    } catch (error) {
      throw new HttpException(
        error instanceof Error ? error.message : 'Failed to set default',
        HttpStatus.NOT_FOUND,
      );
    }
  }

  @Post(':id/reconnect')
  @ApiOperation({
    summary: 'Reconnect a failed connection',
    description: 'Attempts to reconnect a connection that has become disconnected.',
  })
  @ApiParam({ name: 'id', description: 'Connection ID to reconnect' })
  @ApiResponse({ status: 200, description: 'Connection reconnected successfully', type: SuccessResponseDto })
  @ApiResponse({ status: 400, description: 'Reconnection failed' })
  @ApiResponse({ status: 404, description: 'Connection not found' })
  async reconnect(@Param('id') id: string): Promise<SuccessResponseDto> {
    try {
      await this.registry.reconnect(id);
      return { success: true };
    } catch (error) {
      throw new HttpException(
        error instanceof Error ? error.message : 'Failed to reconnect',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Remove a database connection',
    description: 'Removes a connection. The default environment connection cannot be removed.',
  })
  @ApiParam({ name: 'id', description: 'Connection ID to remove' })
  @ApiResponse({ status: 200, description: 'Connection removed successfully', type: SuccessResponseDto })
  @ApiResponse({ status: 400, description: 'Cannot remove connection (e.g., default env connection)' })
  @ApiResponse({ status: 404, description: 'Connection not found' })
  async remove(@Param('id') id: string): Promise<SuccessResponseDto> {
    try {
      await this.registry.removeConnection(id);
      return { success: true };
    } catch (error) {
      throw new HttpException(
        error instanceof Error ? error.message : 'Failed to remove connection',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
