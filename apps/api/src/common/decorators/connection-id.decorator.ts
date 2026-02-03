import { createParamDecorator, ExecutionContext, BadRequestException } from '@nestjs/common';

/**
 * Header name used to pass connection ID from the frontend.
 * This header is set by the frontend when a specific connection is selected.
 */
export const CONNECTION_ID_HEADER = 'x-connection-id';

/**
 * Parameter decorator that extracts the connection ID from the request.
 *
 * The connection ID is read from the X-Connection-Id header.
 * If no header is present and required=true (default), returns undefined
 * to let the service use the default connection.
 *
 * @example
 * ```typescript
 * @Get('data')
 * async getData(@ConnectionId() connectionId?: string) {
 *   return this.service.getData(connectionId);
 * }
 * ```
 *
 * @example With required validation
 * ```typescript
 * @Get('data')
 * async getData(@ConnectionId({ required: true }) connectionId: string) {
 *   return this.service.getData(connectionId);
 * }
 * ```
 */
export const ConnectionId = createParamDecorator(
  (options: { required?: boolean } | undefined, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest();
    const connectionId = request.headers?.[CONNECTION_ID_HEADER] as string | undefined;

    if (options?.required && !connectionId) {
      throw new BadRequestException(
        `Missing required header: ${CONNECTION_ID_HEADER}. Please select a connection.`
      );
    }

    return connectionId;
  },
);
