import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Feature,
  ProposalStatusSchema,
  type ProposalStatus,
  type StoredCacheProposal,
} from '@betterdb/shared';
import { LicenseGuard } from '@proprietary/licenses';
import { RequiresFeature } from '@proprietary/licenses/requires-feature.decorator';
import { ConnectionId } from '@app/common/decorators';
import { parseOptionalInt } from '@app/common/utils/parse-query-param';
import { CacheProposalService } from './cache-proposal.service';
import { mapCacheProposalErrorToHttp } from './errors-http';
import { formatApprovalResult, optionalFiniteNumber, optionalString } from './controller-helpers';

const ACTOR_SOURCE_UI = 'ui' as const;

@ApiTags('cache-proposals')
@Controller('cache-proposals')
@UseGuards(LicenseGuard)
@RequiresFeature(Feature.CACHE_INTELLIGENCE)
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
    try {
      let parsedStatus: ProposalStatus | ProposalStatus[] | undefined;
      if (status !== undefined && status.length > 0) {
        parsedStatus = ProposalStatusSchema.parse(status);
      }
      return await this.service.listProposals({
        connection_id: connectionId,
        status: parsedStatus,
        cache_name: cacheName,
        limit: parseOptionalInt(limit, 'limit') ?? 50,
        offset: parseOptionalInt(offset, 'offset'),
      });
    } catch (err) {
      throw mapCacheProposalErrorToHttp(err);
    }
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
      const newThreshold = optionalFiniteNumber(body?.new_threshold, 'new_threshold');
      const newTtlSeconds = optionalFiniteNumber(body?.new_ttl_seconds, 'new_ttl_seconds');
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

