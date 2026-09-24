import {
  CanActivate,
  CustomDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CONNECTION_ID_HEADER } from '../common/decorators';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { ExternalConnectionUnsupportedError } from './external-connection-unsupported.error';

export const ALLOW_EXTERNAL_CONNECTION_KEY = 'allowExternalConnection';
export const HEADER_CONNECTION_ID_KEY = 'headerConnectionId';

interface GuardedRequest {
  headers?: Record<string, unknown>;
  params?: Record<string, unknown>;
  body?: unknown;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function resolveConnectionId(request: GuardedRequest, headerBound: boolean): string | undefined {
  if (headerBound) return nonEmptyString(request.headers?.[CONNECTION_ID_HEADER]);
  const body =
    typeof request.body === 'object' && request.body !== null
      ? (request.body as Record<string, unknown>)
      : {};
  return (
    nonEmptyString(request.params?.connectionId) ??
    nonEmptyString(body.connectionId) ??
    nonEmptyString(request.headers?.[CONNECTION_ID_HEADER])
  );
}

export function AllowExternalConnection(): CustomDecorator<string> {
  return SetMetadata(ALLOW_EXTERNAL_CONNECTION_KEY, true);
}

export function UseHeaderConnectionId(): CustomDecorator<string> {
  return SetMetadata(HEADER_CONNECTION_ID_KEY, true);
}

@Injectable()
export class LiveConnectionGuard implements CanActivate {
  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.hasMetadata(ALLOW_EXTERNAL_CONNECTION_KEY, context)) return true;
    const connectionId = resolveConnectionId(
      context.switchToHttp().getRequest<GuardedRequest>(),
      this.hasMetadata(HEADER_CONNECTION_ID_KEY, context),
    );
    if (this.registry.getConfig(connectionId)?.connectionType === 'external') {
      throw new ExternalConnectionUnsupportedError(context.getHandler().name);
    }
    return true;
  }

  private hasMetadata(key: string, context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(key, [context.getHandler(), context.getClass()]) ===
      true
    );
  }
}
