import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  BadRequestException,
} from '@nestjs/common';
import { AgentTokensService } from './agent-tokens.service';
import { AgentGateway } from './agent-gateway';

@Controller('agent-tokens')
export class AgentTokensController {
  constructor(
    private readonly tokenService: AgentTokensService,
    private readonly gateway: AgentGateway,
  ) {}

  @Post()
  async generateToken(@Body() body: { name: string }) {
    if (!body.name || !body.name.trim()) {
      throw new BadRequestException('Name is required');
    }
    const result = await this.tokenService.generateToken(body.name.trim());
    return {
      token: result.token,
      id: result.metadata.id,
      name: result.metadata.name,
      expiresAt: result.metadata.expiresAt,
    };
  }

  @Get()
  async listTokens() {
    const tokens = await this.tokenService.listTokens();
    // Never return actual tokens, only metadata
    return tokens.map(t => ({
      id: t.id,
      name: t.name,
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
