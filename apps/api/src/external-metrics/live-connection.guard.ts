import { CanActivate, CustomDecorator, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CONNECTION_ID_HEADER } from '../common/decorators';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { ExternalConnectionUnsupportedError } from './external-connection-unsupported.error';

export const ALLOW_EXTERNAL_CONNECTION_KEY = 'allowExternalConnection';

interface GuardedRequest {
  headers?: Record<string, unknown>;
  params?: Record<string, unknown>;
  body?: unknown;
  query?: Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function resolveConnectionId(request: GuardedRequest): string | undefined {
  const body = typeof request.body === 'object' && request.body !== null ? (request.body as Record<string, unknown>) : {};
  return (
    nonEmptyString(request.params?.connectionId) ??
    nonEmptyString(body.connectionId) ??
    nonEmptyString(request.query?.connectionId) ??
    nonEmptyString(request.headers?.[CONNECTION_ID_HEADER])
  );
}

export function AllowExternalConnection(): CustomDecorator<string> {
  return SetMetadata(ALLOW_EXTERNAL_CONNECTION_KEY, true);
}

@Injectable()
export class LiveConnectionGuard implements CanActivate {
  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (
      this.reflector.getAllAndOverride<boolean>(ALLOW_EXTERNAL_CONNECTION_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    const connectionId = resolveConnectionId(context.switchToHttp().getRequest<GuardedRequest>());
    if (this.registry.getConfig(connectionId)?.connectionType === 'external') {
      throw new ExternalConnectionUnsupportedError(context.getHandler().name);
    }
    return true;
  }
}
