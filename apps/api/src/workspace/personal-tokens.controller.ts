import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Actor, AgentConnectionInfo, AgentToken, TokenType } from '@betterdb/shared';
import { ActivityService, toActivityActor } from '../activity/activity.service';
import { AGENT_GATEWAY, AGENT_TOKENS_SERVICE } from '../auth/agent-gateway.providers';
import { CurrentUser } from '../auth/guards/current-user.decorator';
import { requireSession } from '../auth/guards/require-session';
import { AllowMembers } from '../auth/guards/roles.decorator';
import { CreatePersonalTokenDto } from './dto/create-personal-token.dto';
import { PersonalTokenService, PersonalTokenView } from './personal-token.service';

export interface GeneratedPersonalTokenView {
  token: string;
  id: string;
  name: string;
  type: TokenType;
  expiresAt: number;
}

export const DEMO_TOKENS_MESSAGE = 'Personal tokens are not available on the demo';
export const AGENT_UNAVAILABLE_MESSAGE = 'Agent connections are not available on this instance';

// Structural types for the proprietary services injected in self-hosted mode. They
// are optional (null when the proprietary agent code is not built).
interface AgentTokensLike {
  generateToken(name: string, type: TokenType): Promise<{ token: string; metadata: AgentToken }>;
  listTokens(type?: TokenType): Promise<AgentToken[]>;
  revokeToken(id: string): Promise<void>;
}

interface AgentGatewayLike {
  getConnectedAgents(): AgentConnectionInfo[];
}

function isDemoHost(req: FastifyRequest): boolean {
  const demoHost = process.env.DEMO_HOSTNAME;
  return typeof demoHost === 'string' && demoHost.length > 0 && req.headers.host === demoHost;
}

function toAgentTokenView(token: AgentToken): PersonalTokenView {
  return {
    id: token.id,
    name: token.name,
    type: token.type,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    lastUsedAt: token.lastUsedAt,
    userId: token.userId,
    ownerEmail: null,
  };
}

interface RevokedResponse {
  revoked: true;
}

@Controller('agent-tokens')
export class PersonalTokensController {
  constructor(
    private readonly tokens: PersonalTokenService,
    private readonly activity: ActivityService,
    // Proprietary agent capability, wired in self-hosted mode only (null otherwise).
    @Optional() @Inject(AGENT_TOKENS_SERVICE) private readonly agentTokens: AgentTokensLike | null,
    @Optional() @Inject(AGENT_GATEWAY) private readonly gateway: AgentGatewayLike | null,
  ) {}

  @Post()
  @AllowMembers()
  async create(
    @Body() body: CreatePersonalTokenDto,
    @CurrentUser() actor: Actor,
    @Req() req: FastifyRequest,
  ): Promise<GeneratedPersonalTokenView> {
    requireSession(actor);
    if (isDemoHost(req) === true) {
      throw new ForbiddenException(DEMO_TOKENS_MESSAGE);
    }
    if (body.type === 'agent') {
      return this.createAgentToken(body.name, actor, req);
    }
    const { token, metadata } = await this.tokens.generate(body.name, actor);
    void this.activity.record({
      actor: toActivityActor(actor),
      action: 'token.create',
      statusCode: 201,
      ip: req.ip,
      targetType: 'token',
      targetId: metadata.id,
    });
    return {
      token,
      id: metadata.id,
      name: metadata.name,
      type: metadata.type,
      expiresAt: metadata.expiresAt,
    };
  }

  @Get()
  async list(
    @CurrentUser() actor: Actor,
    @Query('type') type?: string,
  ): Promise<PersonalTokenView[]> {
    if (type === 'agent') {
      const service = this.requireAgent();
      const tokens = await service.listTokens('agent');
      return tokens.map(toAgentTokenView);
    }
    return this.tokens.list(actor);
  }

  @Get('connections')
  getConnections(): AgentConnectionInfo[] {
    return this.gateway ? this.gateway.getConnectedAgents() : [];
  }

  @Delete(':id')
  @AllowMembers()
  async revoke(
    @Param('id') id: string,
    @CurrentUser() actor: Actor,
    @Req() req: FastifyRequest,
  ): Promise<RevokedResponse> {
    requireSession(actor);
    try {
      const { token, changed } = await this.tokens.revoke(id, actor);
      if (changed === false) {
        return { revoked: true };
      }
      void this.activity.record({
        actor: toActivityActor(actor),
        action: 'token.revoke',
        statusCode: 200,
        ip: req.ip,
        targetType: 'token',
        targetId: token.id,
      });
      return { revoked: true };
    } catch (error) {
      // Personal (mcp) revoke throws NotFound for agent tokens (they are type
      // 'agent' with userId null, so PersonalTokenService never sees them). Fall
      // through to the agent service — but ONLY for genuine agent tokens, so this
      // never bypasses the mcp ownership check that also raises NotFound.
      if (error instanceof NotFoundException && this.agentTokens) {
        const agentTokens = await this.agentTokens.listTokens('agent');
        if (agentTokens.some((token) => token.id === id)) {
          await this.agentTokens.revokeToken(id);
          void this.activity.record({
            actor: toActivityActor(actor),
            action: 'token.revoke',
            statusCode: 200,
            ip: req.ip,
            targetType: 'token',
            targetId: id,
          });
          return { revoked: true };
        }
      }
      throw error;
    }
  }

  private async createAgentToken(
    name: string,
    actor: Actor,
    req: FastifyRequest,
  ): Promise<GeneratedPersonalTokenView> {
    const service = this.requireAgent();
    const { token, metadata } = await service.generateToken(name.trim(), 'agent');
    void this.activity.record({
      actor: toActivityActor(actor),
      action: 'token.create',
      statusCode: 201,
      ip: req.ip,
      targetType: 'token',
      targetId: metadata.id,
    });
    return {
      token,
      id: metadata.id,
      name: metadata.name,
      type: metadata.type,
      expiresAt: metadata.expiresAt,
    };
  }

  private requireAgent(): AgentTokensLike {
    if (!this.agentTokens) {
      throw new ServiceUnavailableException(AGENT_UNAVAILABLE_MESSAGE);
    }
    return this.agentTokens;
  }
}
