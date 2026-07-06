import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, Inject, Logger } from '@nestjs/common';
import { FastifyRequest } from 'fastify';

export const MCP_TOKEN_SERVICE = 'MCP_TOKEN_SERVICE';

@Injectable()
export class AgentTokenGuard implements CanActivate {
  private readonly logger = new Logger(AgentTokenGuard.name);

  constructor(
    @Inject(MCP_TOKEN_SERVICE) private readonly tokenService: any,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.tokenService) {
      return true;
    }

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const auth = req.headers['authorization'];
    const raw = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    if (!raw) throw new UnauthorizedException();
    const result = await this.tokenService.validateToken(raw, 'mcp');
    if (!result.valid) throw new UnauthorizedException();
    return true;
  }
}
