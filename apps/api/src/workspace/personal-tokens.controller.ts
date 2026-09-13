import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Actor, TokenType } from '@betterdb/shared';
import { ActivityService, toActivityActor } from '../activity/activity.service';
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

interface RevokedResponse {
  revoked: true;
}

@Controller('agent-tokens')
export class PersonalTokensController {
  constructor(
    private readonly tokens: PersonalTokenService,
    private readonly activity: ActivityService,
  ) {}

  @Post()
  @AllowMembers()
  async create(
    @Body() body: CreatePersonalTokenDto,
    @CurrentUser() actor: Actor,
    @Req() req: FastifyRequest,
  ): Promise<GeneratedPersonalTokenView> {
    requireSession(actor);
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
  async list(@CurrentUser() actor: Actor): Promise<PersonalTokenView[]> {
    return this.tokens.list(actor);
  }

  @Delete(':id')
  @AllowMembers()
  async revoke(
    @Param('id') id: string,
    @CurrentUser() actor: Actor,
    @Req() req: FastifyRequest,
  ): Promise<RevokedResponse> {
    requireSession(actor);
    const token = await this.tokens.revoke(id, actor);
    void this.activity.record({
      actor: toActivityActor(actor),
      action: 'token.revoke',
      statusCode: 200,
      ip: req.ip,
      targetType: 'token',
      targetId: token.id,
    });
    return { revoked: true };
  }
}
