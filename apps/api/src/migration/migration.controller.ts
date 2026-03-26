import { Controller, Get, Post, Delete, Param, Body, NotFoundException, BadRequestException } from '@nestjs/common';
import type { MigrationAnalysisRequest, StartAnalysisResponse, MigrationAnalysisResult } from '@betterdb/shared';
import { MigrationService } from './migration.service';

@Controller('migration')
export class MigrationController {
  constructor(private readonly migrationService: MigrationService) {}

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
}
