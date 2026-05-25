import { Controller, Get, Post, Delete, Param, Body, HttpException, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { CapabilityRetryVerdict, RuntimeCapabilities } from '@betterdb/shared';
import { ConnectionRegistry } from './connection-registry.service';
import {
  CAPABILITY_TEST_COMMAND,
  RuntimeCapabilityTracker,
} from './runtime-capability-tracker.service';
import {
  CreateConnectionDto,
  ConnectionListResponseDto,
  CurrentConnectionResponseDto,
  TestConnectionResponseDto,
  ConnectionIdResponseDto,
  SuccessResponseDto,
} from '../common/dto/connections.dto';

const RUNTIME_CAPABILITY_KEYS = Object.keys(
  CAPABILITY_TEST_COMMAND,
) as ReadonlyArray<keyof RuntimeCapabilities>;

function isRuntimeCapabilityKey(value: string): value is keyof RuntimeCapabilities {
  return RUNTIME_CAPABILITY_KEYS.includes(value as keyof RuntimeCapabilities);
}

/**
 * Hard ceiling on a capability-probe call. iovalkey configures its own
 * `commandTimeout`, but adapters that lack one (or that get stuck before a
 * command is even queued — TLS hand-shaking on a dead server, etc.) would
 * otherwise pin the retry endpoint forever. On timeout the probe yields
 * `available: 'unknown'` and the prior capability state is preserved.
 */
const CAPABILITY_PROBE_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Probe timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

@ApiTags('connections')
@Controller('connections')
export class ConnectionsController {
  // Per-(connection, capability) in-flight probe. The underlying iovalkey
  // `call` cannot be cancelled when our 5s ceiling fires, so we dedupe
  // repeated retry requests onto the same outstanding command instead of
  // stacking new ones on the server.
  private readonly inflightProbes = new Map<string, Promise<unknown>>();

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly capabilityTracker: RuntimeCapabilityTracker,
  ) {}

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

  @Post(':id/capabilities/:capability/retry')
  @ApiOperation({
    summary: 'Force a synchronous probe of a runtime capability',
    description:
      'Runs the capability\'s test command against the live server and returns the verdict (`available: true` / `false` / `"unknown"`). On success the capability is re-enabled; on a definitive rejection it stays (or becomes) disabled with the fresh reason; on transient errors the previous state is preserved.',
  })
  @ApiParam({ name: 'id', description: 'Connection ID' })
  @ApiParam({
    name: 'capability',
    description: 'Runtime capability key (e.g. canSlowLog, canCommandLog, canLatency)',
  })
  @ApiResponse({ status: 200, description: 'Probe completed; see body for verdict' })
  @ApiResponse({ status: 400, description: 'Unknown capability key' })
  @ApiResponse({ status: 404, description: 'Connection not found' })
  async retryCapability(
    @Param('id') id: string,
    @Param('capability') capability: string,
  ): Promise<CapabilityRetryVerdict> {
    if (!isRuntimeCapabilityKey(capability)) {
      throw new HttpException(`Unknown capability: ${capability}`, HttpStatus.BAD_REQUEST);
    }
    const config = this.registry.getConfig(id);
    if (!config) {
      throw new HttpException(`Connection ${id} not found`, HttpStatus.NOT_FOUND);
    }
    const adapter = this.registry.get(id);
    const [command, ...args] = CAPABILITY_TEST_COMMAND[capability];
    const probeKey = `${id}:${capability}`;
    let probe = this.inflightProbes.get(probeKey);
    if (!probe) {
      probe = adapter.call(command, args).finally(() => {
        if (this.inflightProbes.get(probeKey) === probe) {
          this.inflightProbes.delete(probeKey);
        }
      });
      this.inflightProbes.set(probeKey, probe);
    }
    try {
      await withTimeout(probe, CAPABILITY_PROBE_TIMEOUT_MS);
      this.capabilityTracker.resetCapability(id, capability);
      return { available: true };
    } catch (error) {
      const wasBlocked = this.capabilityTracker.recordFailure(
        id,
        capability,
        error instanceof Error ? error : String(error),
      );
      const reason = error instanceof Error ? error.message : String(error);
      if (wasBlocked) {
        return { available: false, reason };
      }
      return { available: 'unknown', reason };
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
