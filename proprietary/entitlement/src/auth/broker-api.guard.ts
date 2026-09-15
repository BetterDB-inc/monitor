import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

const BEARER_PREFIX = 'Bearer ';

@Injectable()
export class BrokerApiGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];

    if (typeof authHeader !== 'string' || authHeader.startsWith(BEARER_PREFIX) === false) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const token = authHeader.slice(BEARER_PREFIX.length);
    const brokerToken = this.config.get<string>('BROKER_API_TOKEN');

    if (!brokerToken) {
      throw new UnauthorizedException('Broker API not configured');
    }

    if (!this.constantTimeCompare(token, brokerToken)) {
      throw new UnauthorizedException('Invalid broker token');
    }

    return true;
  }

  private constantTimeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }

    try {
      return timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch {
      return false;
    }
  }
}
