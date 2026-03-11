import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, Optional, Inject } from '@nestjs/common';
import { FastifyRequest } from 'fastify';

export const MCP_TOKEN_SERVICE = 'MCP_TOKEN_SERVICE';

@Injectable()
export class AgentTokenGuard implements CanActivate {
  constructor(
    @Optional() @Inject(MCP_TOKEN_SERVICE) private readonly tokenService?: any,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // In cloud mode, auth is mandatory — a missing token service means broken config, not community edition
    if (!this.tokenService) {
      if (process.env.CLOUD_MODE) {
        throw new UnauthorizedException('Authentication service unavailable');
      }
      // Community/self-hosted edition: no token service, allow all requests
      return true;
    }

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const auth = req.headers['authorization'];
    const raw = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    if (!raw) throw new UnauthorizedException();
    const result = await this.tokenService.validateToken(raw);
    if (!result.valid) throw new UnauthorizedException();
    return true;
  }
}
