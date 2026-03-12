import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  BadRequestException,
} from '@nestjs/common';
import type { TokenType } from '@betterdb/shared';
import { AgentTokensService } from './agent-tokens.service';
import { AgentGateway } from './agent-gateway';

@Controller('agent-tokens')
export class AgentTokensController {
  constructor(
    private readonly tokenService: AgentTokensService,
    private readonly gateway: AgentGateway,
  ) {}

  @Post()
  async generateToken(@Body() body: { name: string; type?: TokenType }) {
    if (!body.name || !body.name.trim()) {
      throw new BadRequestException('Name is required');
    }
    const type: TokenType = body.type === 'mcp' ? 'mcp' : 'agent';
    const result = await this.tokenService.generateToken(body.name.trim(), type);
    return {
      token: result.token,
      id: result.metadata.id,
      name: result.metadata.name,
      type: result.metadata.type,
      expiresAt: result.metadata.expiresAt,
    };
  }

  @Get()
  async listTokens(@Query('type') type?: string) {
    const tokenType: TokenType | undefined = (type === 'agent' || type === 'mcp') ? type : undefined;
    const tokens = await this.tokenService.listTokens(tokenType);
    // Never return actual tokens, only metadata
    return tokens.map(t => ({
      id: t.id,
      name: t.name,
      type: t.type,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
      revokedAt: t.revokedAt,
      lastUsedAt: t.lastUsedAt,
    }));
  }

  @Delete(':id')
  async revokeToken(@Param('id') id: string) {
    await this.tokenService.revokeToken(id);
    return { revoked: true };
  }

  @Get('/connections')
  getConnections() {
    return this.gateway.getConnectedAgents();
  }
}
