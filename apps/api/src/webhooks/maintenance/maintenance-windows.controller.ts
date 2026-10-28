import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { MaintenanceWindowState, MaintenanceWindowView } from '@betterdb/shared';
import type { RequestWithActor } from '../../auth/guards/actor.guard';
import { MaintenanceWindowService } from './maintenance-window.service';
import {
  CreateMaintenanceWindowDto,
  MaintenanceWindowDto,
  UpdateMaintenanceWindowDto,
} from './maintenance-window.dto';

const STATES: readonly MaintenanceWindowState[] = ['scheduled', 'active', 'ended'];

@ApiTags('maintenance-windows')
@Controller('maintenance-windows')
export class MaintenanceWindowsController {
  constructor(private readonly service: MaintenanceWindowService) {}

  @Get()
  @ApiOperation({
    summary: 'List maintenance windows (active and scheduled first, then the 20 most recently ended)',
  })
  @ApiQuery({ name: 'state', required: false, enum: STATES as unknown as string[] })
  @ApiResponse({ status: 200, type: [MaintenanceWindowDto] })
  async list(@Query('state') state?: string): Promise<MaintenanceWindowView[]> {
    if (state !== undefined && !(STATES as readonly string[]).includes(state)) {
      throw new BadRequestException(`state must be one of: ${STATES.join(', ')}`);
    }
    return this.service.list(state as MaintenanceWindowState | undefined);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one maintenance window' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: MaintenanceWindowDto })
  @ApiResponse({ status: 404, description: 'Maintenance window not found' })
  async get(@Param('id') id: string): Promise<MaintenanceWindowView> {
    return this.service.get(id);
  }

  @Post()
  @ApiOperation({ summary: 'Schedule a maintenance window: matching webhook alerts are recorded but not sent' })
  @ApiResponse({ status: 201, type: MaintenanceWindowDto })
  @ApiResponse({ status: 400, description: 'Invalid window (past start, longer than 7 days, unknown connection)' })
  async create(
    @Body() dto: CreateMaintenanceWindowDto,
    @Req() request: RequestWithActor,
  ): Promise<MaintenanceWindowView> {
    return this.service.create(dto, request.actor?.email ?? null);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename, re-scope events, extend or shorten an open maintenance window' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: MaintenanceWindowDto })
  @ApiResponse({ status: 409, description: 'The window has already ended' })
  async update(@Param('id') id: string, @Body() dto: UpdateMaintenanceWindowDto): Promise<MaintenanceWindowView> {
    return this.service.update(id, dto);
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End an active window now (or cancel a scheduled one)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: MaintenanceWindowDto })
  @ApiResponse({ status: 409, description: 'The window has already ended' })
  async end(@Param('id') id: string): Promise<MaintenanceWindowView> {
    return this.service.end(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a maintenance window (an active one stops silencing immediately)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 204 })
  async delete(@Param('id') id: string): Promise<void> {
    await this.service.delete(id);
  }
}
