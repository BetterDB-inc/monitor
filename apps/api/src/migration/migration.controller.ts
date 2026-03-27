import { Controller, Get, Post, Delete, Param, Body, UseGuards, NotFoundException, BadRequestException } from '@nestjs/common';
import type { MigrationAnalysisRequest, StartAnalysisResponse, MigrationAnalysisResult, MigrationExecutionRequest, StartExecutionResponse, MigrationExecutionResult } from '@betterdb/shared';
import { Feature } from '@betterdb/shared';
import { LicenseGuard } from '@proprietary/licenses';
import { RequiresFeature } from '@proprietary/licenses/requires-feature.decorator';
import { MigrationService } from './migration.service';
import { MigrationExecutionService } from './migration-execution.service';

// Migration analysis is intentionally community-tier (no license guard).
// MIGRATION_EXECUTION gating applies to the execution phase only.
@Controller('migration')
export class MigrationController {
  constructor(
    private readonly migrationService: MigrationService,
    private readonly executionService: MigrationExecutionService,
  ) {}

  // ── Analysis endpoints (community-tier) ──

  @Post('analysis')
  async startAnalysis(@Body() body: MigrationAnalysisRequest): Promise<StartAnalysisResponse> {
    if (!body.sourceConnectionId) {
      throw new BadRequestException('sourceConnectionId is required');
    }
    if (!body.targetConnectionId) {
      throw new BadRequestException('targetConnectionId is required');
    }
    if (body.sourceConnectionId === body.targetConnectionId) {
      throw new BadRequestException('Source and target must be different connections');
    }
    if (body.scanSampleSize !== undefined) {
      if (body.scanSampleSize < 1000 || body.scanSampleSize > 50000) {
        throw new BadRequestException('scanSampleSize must be between 1000 and 50000');
      }
    }
    return this.migrationService.startAnalysis(body);
  }

  @Get('analysis/:id')
  getJob(@Param('id') id: string): MigrationAnalysisResult {
    const job = this.migrationService.getJob(id);
    if (!job) {
      throw new NotFoundException(`Analysis job '${id}' not found`);
    }
    return job;
  }

  @Delete('analysis/:id')
  cancelJob(@Param('id') id: string): { cancelled: boolean } {
    const success = this.migrationService.cancelJob(id);
    if (!success) {
      throw new NotFoundException(`Analysis job '${id}' not found`);
    }
    return { cancelled: true };
  }

  // ── Execution endpoints (Pro-tier) ──

  @Post('execution')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.MIGRATION_EXECUTION)
  async startExecution(@Body() body: MigrationExecutionRequest): Promise<StartExecutionResponse> {
    if (!body.sourceConnectionId) {
      throw new BadRequestException('sourceConnectionId is required');
    }
    if (!body.targetConnectionId) {
      throw new BadRequestException('targetConnectionId is required');
    }
    if (body.sourceConnectionId === body.targetConnectionId) {
      throw new BadRequestException('Source and target must be different connections');
    }
    if (body.mode && body.mode !== 'redis_shake' && body.mode !== 'command') {
      throw new BadRequestException('mode must be "redis_shake" or "command"');
    }
    return this.executionService.startExecution(body);
  }

  @Get('execution/:id')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.MIGRATION_EXECUTION)
  getExecution(@Param('id') id: string): MigrationExecutionResult {
    const result = this.executionService.getExecution(id);
    if (!result) {
      throw new NotFoundException(`Execution job '${id}' not found`);
    }
    return result;
  }

  @Delete('execution/:id')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.MIGRATION_EXECUTION)
  stopExecution(@Param('id') id: string): { stopped: true } {
    const found = this.executionService.stopExecution(id);
    if (!found) {
      throw new NotFoundException(`Execution job '${id}' not found`);
    }
    return { stopped: true };
  }
}
