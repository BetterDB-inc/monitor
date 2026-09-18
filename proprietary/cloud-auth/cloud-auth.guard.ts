import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { isCloudMode } from '@app/common/utils/cloud-mode';
import { FastifyRequest, FastifyReply } from 'fastify';
import type { Actor } from '@betterdb/shared';
import { cloudActor, CloudSessionPayload } from './cloud-actor';
import { readCloudSession } from './cloud-session';

type CloudRequest = FastifyRequest & { cloudUser?: CloudSessionPayload; actor: Actor | null };

@Injectable()
export class CloudAuthGuardImpl implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    // Not in cloud mode — allow everything. Match the codebase convention
    // (isCloudMode()) so a value like "false"/"0" is treated as
    // self-hosted here and everywhere else, not as an ambiguous cloud state.
    if (!isCloudMode()) return true;

    const request = context.switchToHttp().getRequest<CloudRequest>();
    request.actor = null;
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const path = (request.url || '').split('?')[0];

    // Skip auth for callback route, logout route, health checks, agent WebSocket, and static assets.
    // /prometheus/metrics is safe to bypass because PrometheusMetricsGuard
    // requires PROMETHEUS_METRICS_TOKEN, and boot validation makes that token
    // mandatory in cloud mode.
    if (
      path.startsWith('/auth/callback') ||
      path.startsWith('/api/auth/callback') ||
      path.startsWith('/auth/logout') ||
      path.startsWith('/api/auth/logout') ||
      path.startsWith('/api/health') ||
      path.startsWith('/health') ||
      path.startsWith('/agent/ws') ||
      path.startsWith('/api/agent/ws') ||
      path.startsWith('/mcp/') ||
      path.startsWith('/api/mcp/') ||
      path.startsWith('/v1/traces') ||
      path.startsWith('/prometheus/metrics') ||
      path.startsWith('/api/prometheus/metrics') ||
      path.startsWith('/assets/') ||
      path.startsWith('/favicon')
    ) {
      return true;
    }

    // Check session cookie; tenant mismatch, invalid or expired sessions redirect to login
    const payload = readCloudSession(request.headers.cookie, request.headers.host);
    if (payload === null) {
      this.redirectToLogin(reply, request);
      return false;
    }

    // Attach user to request
    request.cloudUser = payload;
    request.actor = cloudActor(payload);
    return true;
  }

  private redirectToLogin(reply: FastifyReply, request: FastifyRequest) {
    const host = request.headers.host || '';
    const redirectUrl = encodeURIComponent(`https://${host}`);
    reply.redirect(`https://betterdb.com/login?redirect=${redirectUrl}`);
  }
}
