import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AgentTokensService } from '../../../../../proprietary/agent/agent-tokens.service';
import { FastifyRequest } from 'fastify';

@Injectable()
export class AgentTokenGuard implements CanActivate {
  constructor(private readonly tokenService: AgentTokensService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const auth = req.headers['authorization'];
    const raw = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    if (!raw) throw new UnauthorizedException();
    const result = await this.tokenService.validateToken(raw);
    if (!result.valid) throw new UnauthorizedException();
    return true;
  }
}
