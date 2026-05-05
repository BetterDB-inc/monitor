import { Injectable, CanActivate, ExecutionContext, NotFoundException } from '@nestjs/common';
import { FastifyRequest } from 'fastify';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Path prefixes that 404 on demo for mutations
const DENIED_MUTATION_PREFIXES = [
  '/connections',
  '/webhooks',
  '/agent/tokens',
  '/team',
  '/admin',
  '/migration',
  '/cli',
  '/settings',
];

// Path prefixes that 404 on demo for any method (read leaks)
const DENIED_READ_PREFIXES = [
  '/team',
  '/agent/tokens',
  '/webhooks',
  '/admin',
  '/settings',
];

@Injectable()
export class DemoModeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const demoHost = process.env.DEMO_HOSTNAME;
    if (!demoHost) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const host = req.headers.host || '';
    if (host !== demoHost) return true;

    const method = (req.method || 'GET').toUpperCase();
    const path = (req.url || '').split('?')[0];
    const apiPath = path.startsWith('/api/') ? path.slice(4) : path;

    if (DENIED_READ_PREFIXES.some(p => apiPath.startsWith(p))) {
      throw new NotFoundException();
    }

    if (MUTATION_METHODS.has(method) && DENIED_MUTATION_PREFIXES.some(p => apiPath.startsWith(p))) {
      throw new NotFoundException();
    }

    return true;
  }
}
