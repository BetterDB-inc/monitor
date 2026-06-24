import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AgentTokenGuard } from '../../common/guards/agent-token.guard';
import { ValidateInstanceIdPipe, safeLimit, safeParseInt } from '../mcp-helpers';
import { McpMemoryService } from './mcp-memory.service';
import type { RecallBodyDto } from './dto';

@Controller('mcp')
@UseGuards(AgentTokenGuard)
export class McpMemoryController {
  constructor(private readonly memory: McpMemoryService) {}

  @Get('instance/:id/memory/stores')
  async getStores(@Param('id', ValidateInstanceIdPipe) id: string) {
    return { stores: await this.memory.discoverStores(id) };
  }

  @Get('instance/:id/memory/:name/list')
  async list(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Param('name') name: string,
    @Query('threadId') threadId?: string,
    @Query('agentId') agentId?: string,
    @Query('namespace') namespace?: string,
    @Query('tags') tags?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.memory.list(id, name, {
      threadId,
      agentId,
      namespace,
      tags: parseTags(tags),
      limit: safeLimit(limit, 20),
      offset: safeParseInt(offset, 0),
    });
  }

  @Get('instance/:id/memory/:name/get/:memoryId')
  async get(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Param('name') name: string,
    @Param('memoryId') memoryId: string,
  ) {
    const item = await this.memory.get(id, name, memoryId);
    if (item === null) {
      throw new HttpException('Memory not found', HttpStatus.NOT_FOUND);
    }
    return item;
  }

  @Get('instance/:id/memory/:name/stats')
  async stats(@Param('id', ValidateInstanceIdPipe) id: string, @Param('name') name: string) {
    return this.memory.stats(id, name);
  }

  @Post('instance/:id/memory/:name/recall')
  async recall(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Param('name') name: string,
    @Body() body: RecallBodyDto,
  ) {
    if (!Array.isArray(body?.vector) || body.vector.length === 0) {
      throw new HttpException('vector must be a non-empty number array', HttpStatus.BAD_REQUEST);
    }
    return {
      hits: await this.memory.recall(id, name, body.vector, {
        k: body.k,
        threshold: body.threshold,
        tags: body.tags,
        threadId: body.scope?.threadId,
        agentId: body.scope?.agentId,
        namespace: body.scope?.namespace,
      }),
    };
  }
}

function parseTags(tags: string | undefined): string[] | undefined {
  if (tags === undefined || tags.length === 0) {
    return undefined;
  }
  return tags.split(',');
}
