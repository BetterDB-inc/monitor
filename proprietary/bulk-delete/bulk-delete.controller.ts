import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { LicenseGuard } from '@proprietary/licenses/license.guard';
import { RequiresFeature } from '@proprietary/licenses/requires-feature.decorator';
import { ConnectionId, CONNECTION_ID_HEADER } from '../../apps/api/src/common/decorators';
import { BulkDeleteService } from './bulk-delete.service';
import { BulkDeleteExecuteDto, BulkDeletePreviewDto } from './dto/bulk-delete.dto';
import { BulkDeleteValidationError } from './bulk-delete-engine';

const FEATURE = 'bulkDelete';

/**
 * REST surface for the SCANDEL-style bulk delete (valkey/valkey#2623).
 * Destructive, so every route requires a connection header and the Pro
 * `bulkDelete` feature. Execute is async: POST returns a job id the UI polls.
 */
@Controller('bulk-delete')
export class BulkDeleteController {
  constructor(private readonly bulkDelete: BulkDeleteService) {}

  /**
   * Start a dry-run job that reports what would be deleted. Runs as a job (like
   * execute) so a large/sparse keyspace can't block the request; poll via
   * GET /jobs/:id. No keys are removed.
   */
  @Post('preview')
  @UseGuards(LicenseGuard)
  @RequiresFeature(FEATURE)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: true, description: 'Connection ID' })
  async preview(
    @ConnectionId({ required: true }) connectionId: string,
    @Body() body: BulkDeletePreviewDto,
  ) {
    try {
      return this.bulkDelete.startPreview(connectionId, body);
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /** Start an async execute run; returns a job id to poll. */
  @Post('execute')
  @UseGuards(LicenseGuard)
  @RequiresFeature(FEATURE)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: true, description: 'Connection ID' })
  async execute(
    @ConnectionId({ required: true }) connectionId: string,
    @Body() body: BulkDeleteExecuteDto,
  ) {
    try {
      return this.bulkDelete.startExecution(connectionId, body);
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /** Poll live progress / final result for a run owned by this connection. */
  @Get('jobs/:id')
  @UseGuards(LicenseGuard)
  @RequiresFeature(FEATURE)
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: true, description: 'Connection ID' })
  async getJob(@ConnectionId({ required: true }) connectionId: string, @Param('id') id: string) {
    const job = this.bulkDelete.getJob(id, connectionId);
    if (!job) throw new NotFoundException(`Bulk delete job '${id}' not found`);
    return job;
  }

  /** Request cooperative cancellation of a running job owned by this connection. */
  @Post('jobs/:id/cancel')
  @UseGuards(LicenseGuard)
  @RequiresFeature(FEATURE)
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: true, description: 'Connection ID' })
  async cancelJob(@ConnectionId({ required: true }) connectionId: string, @Param('id') id: string) {
    const result = this.bulkDelete.cancelJob(id, connectionId);
    if (result === null) throw new NotFoundException(`Bulk delete job '${id}' not found`);
    return { cancelled: result };
  }

  /** Recent execute-run audit records for the connection. */
  @Get('audits')
  @UseGuards(LicenseGuard)
  @RequiresFeature(FEATURE)
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: true, description: 'Connection ID' })
  async listAudits(
    @ConnectionId({ required: true }) connectionId: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = limit ? parseInt(limit, 10) : undefined;
    // Clamp to [1, 500]; a negative/zero limit must never reach storage
    // (LIMIT -1 means "no limit" in SQLite and errors in Postgres).
    const safeLimit =
      parsed !== undefined && !isNaN(parsed) ? Math.min(Math.max(parsed, 1), 500) : undefined;
    return this.bulkDelete.listAudits(connectionId, safeLimit);
  }

  private mapError(err: unknown): Error {
    if (err instanceof BulkDeleteValidationError) {
      return new BadRequestException(err.message);
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}
