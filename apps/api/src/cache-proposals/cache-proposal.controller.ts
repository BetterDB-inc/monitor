import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ProposalStatusSchema,
  type ProposalStatus,
  type StoredCacheProposal,
} from '@betterdb/shared';
import { ConnectionId } from '../common/decorators';
import { parseOptionalInt } from '../common/utils/parse-query-param';
import { CacheProposalService } from './cache-proposal.service';
import { mapCacheProposalErrorToHttp } from './errors-http';

const ACTOR_SOURCE_UI = 'ui' as const;

@ApiTags('cache-proposals')
@Controller('cache-proposals')
export class CacheProposalController {
  constructor(private readonly service: CacheProposalService) {}

  @Get('pending')
  @ApiOperation({ summary: 'List pending cache proposals for the active connection' })
  async listPending(
    @ConnectionId({ required: true }) connectionId: string,
    @Query('cache_name') cacheName?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<StoredCacheProposal[]> {
    return this.service.listProposals({
      connection_id: connectionId,
      status: 'pending',
      cache_name: cacheName,
      limit: parseOptionalInt(limit, 'limit'),
      offset: parseOptionalInt(offset, 'offset'),
    });
  }

  @Get('history')
  @ApiOperation({ summary: 'List historical cache proposals (any non-pending status)' })
  async history(
    @ConnectionId({ required: true }) connectionId: string,
    @Query('status') status?: string,
    @Query('cache_name') cacheName?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<StoredCacheProposal[]> {
    let parsedStatus: ProposalStatus | ProposalStatus[] | undefined;
    if (status !== undefined && status.length > 0) {
      parsedStatus = ProposalStatusSchema.parse(status);
    }
    return this.service.listProposals({
      connection_id: connectionId,
      status: parsedStatus,
      cache_name: cacheName,
      limit: parseOptionalInt(limit, 'limit') ?? 50,
      offset: parseOptionalInt(offset, 'offset'),
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a cache proposal with its audit trail' })
  async get(@Param('id') id: string): Promise<{
    proposal: StoredCacheProposal;
    audit: Awaited<ReturnType<CacheProposalService['getProposalWithAudit']>>['audit'];
  }> {
    try {
      return await this.service.getProposalWithAudit(id);
    } catch (err) {
      throw mapCacheProposalErrorToHttp(err);
    }
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve a pending cache proposal' })
  async approve(
    @Param('id') id: string,
    @Body() body?: { actor?: unknown },
  ): Promise<unknown> {
    try {
      const actor = optionalString(body?.actor, 'actor') ?? null;
      const result = await this.service.approve({
        proposalId: id,
        actor,
        actorSource: ACTOR_SOURCE_UI,
      });
      return formatApprovalResult(result);
    } catch (err) {
      throw mapCacheProposalErrorToHttp(err);
    }
  }

  @Post(':id/reject')
  @ApiOperation({ summary: 'Reject a pending cache proposal' })
  async reject(
    @Param('id') id: string,
    @Body() body?: { reason?: unknown; actor?: unknown },
  ): Promise<unknown> {
    try {
      const reason = optionalString(body?.reason, 'reason') ?? null;
      const actor = optionalString(body?.actor, 'actor') ?? null;
      const proposal = await this.service.reject({
        proposalId: id,
        reason,
        actor,
        actorSource: ACTOR_SOURCE_UI,
      });
      return { proposal_id: proposal.id, status: proposal.status };
    } catch (err) {
      throw mapCacheProposalErrorToHttp(err);
    }
  }

  @Post(':id/edit-and-approve')
  @ApiOperation({ summary: 'Edit a pending cache proposal and approve it' })
  async editAndApprove(
    @Param('id') id: string,
    @Body()
    body: {
      new_threshold?: unknown;
      new_ttl_seconds?: unknown;
      actor?: unknown;
    },
  ): Promise<unknown> {
    try {
      const newThreshold = optionalNumber(body?.new_threshold, 'new_threshold');
      const newTtlSeconds = optionalNumber(body?.new_ttl_seconds, 'new_ttl_seconds');
      const actor = optionalString(body?.actor, 'actor') ?? null;
      if (newThreshold === undefined && newTtlSeconds === undefined) {
        throw new BadRequestException('Either new_threshold or new_ttl_seconds is required');
      }
      const result = await this.service.editAndApprove({
        proposalId: id,
        edits: { newThreshold, newTtlSeconds },
        actor,
        actorSource: ACTOR_SOURCE_UI,
      });
      return formatApprovalResult(result);
    } catch (err) {
      throw mapCacheProposalErrorToHttp(err);
    }
  }
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string when provided`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BadRequestException(`${field} must be a finite number when provided`);
  }
  return value;
}

function formatApprovalResult(result: {
  proposal: StoredCacheProposal;
  appliedResult: { success: boolean; error?: string; details?: Record<string, unknown> } | null;
}): unknown {
  return {
    proposal_id: result.proposal.id,
    status: result.proposal.status,
    applied_result: result.appliedResult,
  };
}

