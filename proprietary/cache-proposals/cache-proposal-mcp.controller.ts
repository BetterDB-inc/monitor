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
import { Feature, type StoredCacheProposal } from '@betterdb/shared';
import { LicenseGuard } from '@proprietary/licenses';
import { RequiresFeature } from '@proprietary/licenses/requires-feature.decorator';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { ValidateInstanceIdPipe, safeLimit, safeParseInt } from '@app/mcp/mcp-helpers';
import { CacheProposalService } from './cache-proposal.service';
import { CacheReadonlyService } from './cache-readonly.service';
import { mapCacheProposalErrorToHttp } from './errors-http';
import {
  formatApprovalResult,
  optionalFiniteNumber,
  optionalString,
} from './controller-helpers';

const CACHE_NAME_RE = /^[A-Za-z0-9_:.-]{1,128}$/;

function requireCacheName(value: string): string {
  if (!CACHE_NAME_RE.test(value)) {
    throw new BadRequestException(`Invalid cache_name. Must match ${CACHE_NAME_RE.source}.`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequestException(`${field} is required and must be a non-empty string`);
  }
  return value;
}

function optionalNullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string or null when provided`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BadRequestException(`${field} is required and must be a finite number`);
  }
  return value;
}

function formatProposalResult(result: { proposal: StoredCacheProposal; warnings: string[] }) {
  const { proposal, warnings } = result;
  return {
    proposal_id: proposal.id,
    status: proposal.status,
    expires_at: proposal.expires_at,
    warnings,
  };
}

@Controller('mcp')
@UseGuards(AgentTokenGuard, LicenseGuard)
@RequiresFeature(Feature.CACHE_INTELLIGENCE)
export class CacheProposalMcpController {
  constructor(
    private readonly cacheProposalService: CacheProposalService,
    private readonly cacheReadonlyService: CacheReadonlyService,
  ) {}

  @Get('instance/:id/caches')
  async listCachesEndpoint(@Param('id', ValidateInstanceIdPipe) id: string) {
    try {
      const caches = await this.cacheReadonlyService.listCaches(id);
      return { caches };
    } catch (err) {
      throw mapCacheProposalErrorToHttp(err);
    }
  }

  @Get('instance/:id/caches/:name/health')
  async cacheHealthEndpoint(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Param('name') name: string,
  ) {
    try {
      return await this.cacheReadonlyService.cacheHealth(id, requireCacheName(name));
    } catch (err) {
      throw mapCacheProposalErrorToHttp(err);
    }
  }

  @Get('instance/:id/caches/:name/threshold-recommendation')
  async cacheThresholdRecommendationEndpoint(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Param('name') name: string,
    @Query('category') category?: string,
    @Query('minSamples') minSamples?: string,
  ) {
    try {
      return await this.cacheReadonlyService.thresholdRecommendation(
        id,
        requireCacheName(name),
        {
          category: category && category.length > 0 ? category : undefined,
          minSamples: minSamples ? safeParseInt(minSamples) : undefined,
        },
      );
    } catch (err) {
      throw mapCacheProposalErrorToHttp(err);
    }
  }

  @Get('instance/:id/caches/:name/tool-effectiveness')
  async cacheToolEffectivenessEndpoint(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Param('name') name: string,
  ) {
    try {
      const tools = await this.cacheReadonlyService.toolEffectiveness(
        id,
        requireCacheName(name),
      );
      return { tools };
    } catch (err) {
      throw mapCacheProposalErrorToHttp(err);
    }
  }

  @Get('instance/:id/caches/:name/similarity-distribution')
  async cacheSimilarityDistributionEndpoint(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Param('name') name: string,
    @Query('category') category?: string,
    @Query('windowHours') windowHours?: string,
  ) {
    try {
      return await this.cacheReadonlyService.similarityDistribution(
        id,
        requireCacheName(name),
        {
          category: category && category.length > 0 ? category : undefined,
          windowHours: windowHours ? safeParseInt(windowHours) : undefined,
        },
      );
    } catch (err) {
      throw mapCacheProposalErrorToHttp(err);
    }
  }

  @Get('instance/:id/caches/:name/recent-changes')
  async cacheRecentChangesEndpoint(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Param('name') name: string,
    @Query('limit') limit?: string,
  ) {
    try {
      const proposals = await this.cacheReadonlyService.recentChanges(
        id,
        requireCacheName(name),
        limit ? safeParseInt(limit, 20) : 20,
      );
      return { proposals };
    } catch (err) {
      throw mapCacheProposalErrorToHttp(err);
    }
  }

  @Post('instance/:id/cache-proposals/threshold-adjust')
  async proposeCacheThresholdAdjust(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Body()
    body: {
      cache_name?: unknown;
      category?: unknown;
      new_threshold?: unknown;
      reasoning?: unknown;
      proposed_by?: unknown;
    },
  ) {
    const cacheName = requireString(body?.cache_name, 'cache_name');
    const newThreshold = requireFiniteNumber(body?.new_threshold, 'new_threshold');
    const reasoning = requireString(body?.reasoning, 'reasoning');
    const category = optionalNullableString(body?.category, 'category');
    const proposedBy = optionalString(body?.proposed_by, 'proposed_by');

    try {
      const result = await this.cacheProposalService.proposeThresholdAdjust(id, {
        cacheName,
        newThreshold,
        reasoning,
        category,
        proposedBy,
      });
      return formatProposalResult(result);
    } catch (err) {
      throw mapCacheProposalErrorToHttp(err);
    }
  }

  @Post('instance/:id/cache-proposals/tool-ttl-adjust')
  async proposeCacheToolTtlAdjust(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Body()
    body: {
      cache_name?: unknown;
      tool_name?: unknown;
      new_ttl_seconds?: unknown;
      reasoning?: unknown;
      proposed_by?: unknown;
    },
  ) {
    const cacheName = requireString(body?.cache_name, 'cache_name');
    const toolName = requireString(body?.tool_name, 'tool_name');
    const newTtlSeconds = requireFiniteNumber(body?.new_ttl_seconds, 'new_ttl_seconds');
    const reasoning = requireString(body?.reasoning, 'reasoning');
    const proposedBy = optionalString(body?.proposed_by, 'proposed_by');

    try {
      const result = await this.cacheProposalService.proposeToolTtlAdjust(id, {
        cacheName,
        toolName,
        newTtlSeconds,
        reasoning,
        proposedBy,
      });
      return formatProposalResult(result);
    } catch (err) {
      throw mapCacheProposalErrorToHttp(err);
    }
  }

  @Post('instance/:id/cache-proposals/invalidate')
  async proposeCacheInvalidate(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Body()
    body: {
      cache_name?: unknown;
      filter_kind?: unknown;
      filter_expression?: unknown;
      filter_value?: unknown;
      estimated_affected?: unknown;
      reasoning?: unknown;
      proposed_by?: unknown;
    },
  ) {
    const cacheName = requireString(body?.cache_name, 'cache_name');
    const filterKind = requireString(body?.filter_kind, 'filter_kind');
    const estimatedAffected = requireFiniteNumber(body?.estimated_affected, 'estimated_affected');
    const reasoning = requireString(body?.reasoning, 'reasoning');
    const proposedBy = optionalString(body?.proposed_by, 'proposed_by');

    if (
      filterKind !== 'valkey_search' &&
      filterKind !== 'tool' &&
      filterKind !== 'key_prefix' &&
      filterKind !== 'session'
    ) {
      throw new BadRequestException(
        `filter_kind must be one of 'valkey_search' | 'tool' | 'key_prefix' | 'session', got '${filterKind}'`,
      );
    }

    try {
      if (filterKind === 'valkey_search') {
        const filterExpression = requireString(body?.filter_expression, 'filter_expression');
        const result = await this.cacheProposalService.proposeInvalidate(id, {
          cacheName,
          filterKind: 'valkey_search',
          filterExpression,
          estimatedAffected,
          reasoning,
          proposedBy,
        });
        return formatProposalResult(result);
      }

      const filterValue = requireString(body?.filter_value, 'filter_value');
      const result = await this.cacheProposalService.proposeInvalidate(id, {
        cacheName,
        filterKind,
        filterValue,
        estimatedAffected,
        reasoning,
        proposedBy,
      });
      return formatProposalResult(result);
    } catch (err) {
      throw mapCacheProposalErrorToHttp(err);
    }
  }

  @Get('instance/:id/cache-proposals/pending')
  async listPendingCacheProposals(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('cache_name') cacheName?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      const parsedLimit = limit ? safeLimit(limit, 100) : 100;
      return await this.cacheProposalService.listProposals({
        connection_id: id,
        status: 'pending',
        cache_name: cacheName,
        limit: parsedLimit,
      });
    } catch (err) {
      throw mapCacheProposalErrorToHttp(err);
    }
  }

  @Get('cache-proposals/:proposalId')
  async getCacheProposal(@Param('proposalId') proposalId: string) {
    try {
      return await this.cacheProposalService.getProposalWithAudit(proposalId);
    } catch (err) {
      throw mapCacheProposalErrorToHttp(err);
    }
  }

  @Post('cache-proposals/:proposalId/approve')
  async approveCacheProposal(
    @Param('proposalId') proposalId: string,
    @Body() body?: { actor?: unknown },
  ) {
    try {
      const actor = optionalString(body?.actor, 'actor') ?? null;
      const result = await this.cacheProposalService.approve({
        proposalId,
        actor,
        actorSource: 'mcp',
      });
      return formatApprovalResult(result);
    } catch (err) {
      throw mapCacheProposalErrorToHttp(err);
    }
  }

  @Post('cache-proposals/:proposalId/reject')
  async rejectCacheProposal(
    @Param('proposalId') proposalId: string,
    @Body() body?: { reason?: unknown; actor?: unknown },
  ) {
    try {
      const reason = optionalString(body?.reason, 'reason') ?? null;
      const actor = optionalString(body?.actor, 'actor') ?? null;
      const proposal = await this.cacheProposalService.reject({
        proposalId,
        reason,
        actor,
        actorSource: 'mcp',
      });
      return { proposal_id: proposal.id, status: proposal.status };
    } catch (err) {
      throw mapCacheProposalErrorToHttp(err);
    }
  }

  @Post('cache-proposals/:proposalId/edit-and-approve')
  async editAndApproveCacheProposal(
    @Param('proposalId') proposalId: string,
    @Body()
    body: {
      new_threshold?: unknown;
      new_ttl_seconds?: unknown;
      actor?: unknown;
    },
  ) {
    try {
      const newThreshold = optionalFiniteNumber(body?.new_threshold, 'new_threshold');
      const newTtlSeconds = optionalFiniteNumber(body?.new_ttl_seconds, 'new_ttl_seconds');
      const actor = optionalString(body?.actor, 'actor') ?? null;
      if (newThreshold === undefined && newTtlSeconds === undefined) {
        throw new BadRequestException('Either new_threshold or new_ttl_seconds is required');
      }
      const result = await this.cacheProposalService.editAndApprove({
        proposalId,
        edits: { newThreshold, newTtlSeconds },
        actor,
        actorSource: 'mcp',
      });
      return formatApprovalResult(result);
    } catch (err) {
      throw mapCacheProposalErrorToHttp(err);
    }
  }
}
