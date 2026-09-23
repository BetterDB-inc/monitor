import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ExternalConnectionUnsupportedError } from './external-connection-unsupported.error';

@Catch(ExternalConnectionUnsupportedError)
export class ExternalConnectionUnsupportedFilter implements ExceptionFilter {
  catch(error: ExternalConnectionUnsupportedError, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw error;
    host
      .switchToHttp()
      .getResponse<FastifyReply>()
      .status(501)
      .send({
        statusCode: 501,
        code: 'EXTERNAL_CONNECTION_UNSUPPORTED',
        method: error.method,
        message: error.message,
      });
  }
}
