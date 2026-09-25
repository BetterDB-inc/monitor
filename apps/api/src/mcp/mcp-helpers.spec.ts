import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { CapabilityUnavailableError } from '../common/errors/capability-unavailable.error';
import { ExternalConnectionUnsupportedError } from '../external-metrics/external-connection-unsupported.error';
import { mapMcpError } from './mcp-helpers';

describe('mapMcpError', () => {
  let logger: jest.Mocked<Logger>;

  beforeEach(() => {
    logger = { error: jest.fn() } as unknown as jest.Mocked<Logger>;
  });

  it('rethrows ExternalConnectionUnsupportedError unchanged without logging', () => {
    const error = new ExternalConnectionUnsupportedError('getInfo');

    expect(() => {
      throw mapMcpError(logger, error, 'Failed to get info');
    }).toThrow(error);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('returns the original HttpException unchanged', () => {
    const error = new HttpException('bad request', HttpStatus.BAD_REQUEST);

    expect(mapMcpError(logger, error, 'fallback')).toBe(error);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('maps CapabilityUnavailableError to 501', () => {
    const error = new CapabilityUnavailableError('not available');

    const result = mapMcpError(logger, error, 'fallback');

    expect(result.getStatus()).toBe(HttpStatus.NOT_IMPLEMENTED);
    expect(result.message).toBe('not available');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs and maps unknown errors to 500', () => {
    const error = new Error('boom');

    const result = mapMcpError(logger, error, 'fallback', 'log message');

    expect(result.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(result.message).toBe('fallback');
    expect(logger.error).toHaveBeenCalledWith('log message', error.stack);
  });
});
