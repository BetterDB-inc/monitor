import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { StoredMemoryProposal } from '@betterdb/shared';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { ValidateInstanceIdPipe, safeLimit } from '@app/mcp/mcp-helpers';
import { MemoryProposalService } from './memory-proposal.service';
import type { MemoryApplyResult } from './memory-apply.service';
import { mapMemoryProposalErrorToHttp } from './errors-http';
import { optionalString } from '../cache-proposals/controller-helpers';

@Controller('mcp')
@UseGuards(AgentTokenGuard)
export class MemoryProposalMcpController {
  constructor(private readonly service: MemoryProposalService) {}

  @Post('instance/:id/memory-proposals/forget')
  async proposeForget(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Body()
    body: {
      memory_name?: unknown;
      id?: unknown;
      scope?: unknown;
      tags?: unknown;
      reasoning?: unknown;
      proposed_by?: unknown;
    },
  ) {
    try {
      const storeName = requireString(body?.memory_name, 'memory_name');
      const reasoning = requireString(body?.reasoning, 'reasoning');
      const result = await this.service.proposeForget(id, {
        storeName,
        reasoning,
        memoryId: optionalString(body?.id, 'id'),
        scope: parseScope(body?.scope),
        tags: parseTags(body?.tags),
        proposedBy: optionalString(body?.proposed_by, 'proposed_by'),
      });
      return formatProposalResult(result);
    } catch (err) {
      throw mapMemoryProposalErrorToHttp(err);
    }
  }

  @Get('instance/:id/memory-proposals/pending')
  async listPending(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('memory_name') memoryName?: string,
    @Query('limit') limit?: string,
  ) {
    const proposals = await this.service.listPending(id, {
      storeName: memoryName,
      limit: safeLimit(limit, 50),
    });
    return { proposals };
  }

  @Get('memory-proposals/:proposalId')
  async getProposal(@Param('proposalId') proposalId: string) {
    const proposal = await this.service.get(proposalId);
    if (proposal === null) {
      throw new HttpException('Memory proposal not found', HttpStatus.NOT_FOUND);
    }
    return proposal;
  }

  @Post('memory-proposals/:proposalId/approve')
  async approve(@Param('proposalId') proposalId: string, @Body() body?: { actor?: unknown }) {
    try {
      const actor = optionalString(body?.actor, 'actor') ?? null;
      const result = await this.service.approve({ proposalId, actor, actorSource: 'mcp' });
      return formatApprovalResult(result);
    } catch (err) {
      throw mapMemoryProposalErrorToHttp(err);
    }
  }

  @Post('memory-proposals/:proposalId/reject')
  async reject(
    @Param('proposalId') proposalId: string,
    @Body() body?: { actor?: unknown; reason?: unknown },
  ) {
    try {
      const actor = optionalString(body?.actor, 'actor') ?? null;
      const reason = optionalString(body?.reason, 'reason') ?? null;
      const proposal = await this.service.reject({ proposalId, reason, actor, actorSource: 'mcp' });
      return { proposal_id: proposal.id, status: proposal.status };
    } catch (err) {
      throw mapMemoryProposalErrorToHttp(err);
    }
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpException(`${field} is required`, HttpStatus.BAD_REQUEST);
  }
  return value;
}

function parseScope(
  value: unknown,
): { threadId?: string; agentId?: string; namespace?: string } | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const scope: { threadId?: string; agentId?: string; namespace?: string } = {};
  if (typeof raw.threadId === 'string') {
    scope.threadId = raw.threadId;
  }
  if (typeof raw.agentId === 'string') {
    scope.agentId = raw.agentId;
  }
  if (typeof raw.namespace === 'string') {
    scope.namespace = raw.namespace;
  }
  return scope;
}

function parseTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tags = value.filter((t): t is string => typeof t === 'string');
  return tags.length > 0 ? tags : undefined;
}

function formatProposalResult(result: { proposal: StoredMemoryProposal; warnings: string[] }) {
  return {
    proposal_id: result.proposal.id,
    status: result.proposal.status,
    expires_at: result.proposal.expires_at,
    warnings: result.warnings,
  };
}

function formatApprovalResult(result: MemoryApplyResult) {
  return {
    proposal_id: result.proposal.id,
    status: result.proposal.status,
    applied_result: result.appliedResult,
  };
}
