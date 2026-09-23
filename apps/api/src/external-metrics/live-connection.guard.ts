import { CanActivate, CustomDecorator, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CONNECTION_ID_HEADER } from '../common/decorators';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { ExternalConnectionUnsupportedError } from './external-connection-unsupported.error';

export const ALLOW_EXTERNAL_CONNECTION_KEY = 'allowExternalConnection';

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
    if (this.reflector.get<boolean>(ALLOW_EXTERNAL_CONNECTION_KEY, context.getHandler())) return true;
    const request = context.switchToHttp().getRequest<{ headers?: Record<string, unknown> }>();
    const header = request.headers?.[CONNECTION_ID_HEADER];
    const connectionId = typeof header === 'string' && header !== '' ? header : undefined;
    if (this.registry.getConfig(connectionId)?.connectionType === 'external') {
      throw new ExternalConnectionUnsupportedError(context.getHandler().name);
    }
    return true;
  }
}
