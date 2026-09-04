import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Observable, tap } from 'rxjs';
import type { Actor } from '@betterdb/shared';
import type { RequestWithActor } from '../auth/guards/actor.guard';
import { isPublicPath, normalizePath } from '../auth/guards/public-paths';
import { CONNECTION_ID_HEADER } from '../common/decorators/connection-id.decorator';
import { actionFor, targetFor } from './activity-actions';
import { ActivityService, toActivityActor } from './activity.service';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function errorStatus(error: unknown): number {
  if (error instanceof HttpException) {
    return error.getStatus();
  }
  return 500;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  if (value === undefined || value.length === 0) {
    return null;
  }
  return value;
}

@Injectable()
export class ActivityInterceptor implements NestInterceptor {
  constructor(private readonly activity: ActivityService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const request = context.switchToHttp().getRequest<RequestWithActor>();
    const actor = request.actor ?? null;
    if (actor === null) {
      return next.handle();
    }
    const method = request.method.toUpperCase();
    if (READ_METHODS.has(method) === true) {
      return next.handle();
    }
    if (isPublicPath(request.url) === true) {
      return next.handle();
    }
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const pattern = request.routeOptions.url ?? normalizePath(request.url);
    const action = actionFor(method, pattern);
    return next.handle().pipe(
      tap({
        next: (body: unknown) => {
          this.emit(request, actor, action, reply.statusCode, body);
        },
        error: (error: unknown) => {
          this.emit(request, actor, action, errorStatus(error), undefined);
        },
      }),
    );
  }

  private emit(
    request: RequestWithActor,
    actor: Actor,
    action: string,
    statusCode: number,
    response: unknown,
  ): void {
    const params = (request.params ?? {}) as Record<string, string>;
    const target = targetFor(action, params, request.body, response);
    void this.activity.record({
      actor: toActivityActor(actor),
      action,
      statusCode,
      ip: request.ip,
      connectionId: headerValue(request.headers[CONNECTION_ID_HEADER]),
      targetType: target === null ? null : target.type,
      targetId: target === null ? null : target.id,
      details: { method: request.method.toUpperCase(), path: normalizePath(request.url) },
    });
  }
}
