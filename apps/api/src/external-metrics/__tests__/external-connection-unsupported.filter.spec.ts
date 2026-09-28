import type { ArgumentsHost } from '@nestjs/common';
import { ExternalConnectionUnsupportedFilter } from '../external-connection-unsupported.filter';
import { ExternalConnectionUnsupportedError } from '../external-connection-unsupported.error';

function httpHost(reply: { status: jest.Mock; send: jest.Mock }): ArgumentsHost {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => reply }),
  } as unknown as ArgumentsHost;
}

describe('ExternalConnectionUnsupportedFilter', () => {
  it('maps the error to 501 with a stable code', () => {
    const reply = { status: jest.fn(), send: jest.fn() };
    reply.status.mockReturnValue(reply);
    new ExternalConnectionUnsupportedFilter().catch(new ExternalConnectionUnsupportedError('getSlowLog'), httpHost(reply));
    expect(reply.status).toHaveBeenCalledWith(501);
    expect(reply.send).toHaveBeenCalledWith({
      statusCode: 501,
      code: 'EXTERNAL_CONNECTION_UNSUPPORTED',
      method: 'getSlowLog',
      message: 'getSlowLog is not available for OTLP-ingested connections',
    });
  });

  it('rethrows outside HTTP', () => {
    const error = new ExternalConnectionUnsupportedError('call');
    const host = { getType: () => 'ws' } as unknown as ArgumentsHost;
    expect(() => new ExternalConnectionUnsupportedFilter().catch(error, host)).toThrow(error);
  });
});
