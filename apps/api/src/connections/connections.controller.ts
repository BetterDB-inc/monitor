import { Controller, Get, Post, Delete, Param, Body, HttpException, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CreateConnectionRequest, ConnectionListResponse, CurrentConnectionResponse, TestConnectionResponse } from '@betterdb/shared';
import { ConnectionRegistry } from './connection-registry.service';

@ApiTags('connections')
@Controller('connections')
export class ConnectionsController {
  constructor(private readonly registry: ConnectionRegistry) {}

  @Get()
  @ApiOperation({ summary: 'List all database connections with status' })
  @ApiResponse({ status: 200, description: 'Returns all connections with their status' })
  list(): ConnectionListResponse {
    return {
      connections: this.registry.list(),
      currentId: this.registry.getDefaultId(),
    };
  }

  @Get('current')
  @ApiOperation({ summary: 'Get the current default connection ID' })
  @ApiResponse({ status: 200, description: 'Returns the current default connection ID' })
  getCurrent(): CurrentConnectionResponse {
    return {
      id: this.registry.getDefaultId(),
    };
  }

  @Post()
  @ApiOperation({ summary: 'Create a new database connection' })
  @ApiResponse({ status: 201, description: 'Connection created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid connection configuration or connection failed' })
  async create(@Body() request: CreateConnectionRequest): Promise<{ id: string }> {
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
  @ApiOperation({ summary: 'Test a connection without saving' })
  @ApiResponse({ status: 200, description: 'Connection test result' })
  async test(@Body() request: CreateConnectionRequest): Promise<TestConnectionResponse> {
    return this.registry.testConnection(request);
  }

  @Post(':id/default')
  @ApiOperation({ summary: 'Set a connection as the default' })
  @ApiResponse({ status: 200, description: 'Default connection updated' })
  @ApiResponse({ status: 404, description: 'Connection not found' })
  async setDefault(@Param('id') id: string): Promise<{ success: boolean }> {
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
  @ApiOperation({ summary: 'Reconnect a failed connection' })
  @ApiResponse({ status: 200, description: 'Connection reconnected' })
  @ApiResponse({ status: 400, description: 'Reconnection failed' })
  async reconnect(@Param('id') id: string): Promise<{ success: boolean }> {
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
  @ApiOperation({ summary: 'Remove a database connection' })
  @ApiResponse({ status: 200, description: 'Connection removed' })
  @ApiResponse({ status: 400, description: 'Cannot remove connection' })
  async remove(@Param('id') id: string): Promise<{ success: boolean }> {
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
