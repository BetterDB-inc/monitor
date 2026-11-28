import { ArgumentsHost, Catch, HttpException, HttpStatus } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { FastifyReply } from 'fastify';
import { AgentReadOnlyError, isAgentReadOnlyError } from '../errors/agent-read-only.error';

/**
 * Answers 403 whenever a request failed because a read-only agent connection
 * refused a state-changing command, whether the error reached here as is or
 * wrapped by a controller (as the HttpException's cause). Every other
 * exception gets Nest's default handling.
 */
@Catch(AgentReadOnlyError, HttpException)
export class AgentReadOnlyFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http' || !isAgentReadOnlyError(exception)) {
      super.catch(exception, host);
      return;
    }
    const message = exception instanceof Error ? exception.message : 'This agent connection is read-only.';
    host
      .switchToHttp()
      .getResponse<FastifyReply>()
      .status(HttpStatus.FORBIDDEN)
      .send({
        statusCode: HttpStatus.FORBIDDEN,
        code: 'AGENT_READ_ONLY',
        message,
      });
  }
}
