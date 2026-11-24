import { HttpException, HttpStatus } from '@nestjs/common';
import { AGENT_READ_ONLY_MESSAGE } from '@betterdb/shared';
import { MetricsController } from '../metrics.controller';

// A read-only agent connection refuses the RESET commands; the controller
// must report that as the caller's problem (403), not a server failure.
describe('MetricsController reset on a read-only agent connection', () => {
  function controllerWith(error: Error) {
    const service = {
      resetSlowLog: jest.fn().mockRejectedValue(error),
      resetCommandLog: jest.fn().mockRejectedValue(error),
      resetLatencyEvents: jest.fn().mockRejectedValue(error),
    };
    return new MetricsController(service as never, {} as never, {} as never);
  }

  async function statusOf(call: () => Promise<unknown>): Promise<number> {
    try {
      await call();
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      return (err as HttpException).getStatus();
    }
    throw new Error('expected the call to throw');
  }

  it('answers 403 for the read-only refusal on every RESET route', async () => {
    const controller = controllerWith(new Error(AGENT_READ_ONLY_MESSAGE));

    expect(await statusOf(() => controller.resetSlowLog('agent-1'))).toBe(HttpStatus.FORBIDDEN);
    expect(await statusOf(() => controller.resetCommandLog('slow', 'agent-1'))).toBe(HttpStatus.FORBIDDEN);
    expect(await statusOf(() => controller.resetLatencyEvents(undefined, 'agent-1'))).toBe(HttpStatus.FORBIDDEN);
  });

  it('keeps 500 (and 501 for an unsupported commandlog) for other failures', async () => {
    const controller = controllerWith(new Error('connection lost'));
    expect(await statusOf(() => controller.resetSlowLog('agent-1'))).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(await statusOf(() => controller.resetLatencyEvents(undefined, 'agent-1'))).toBe(HttpStatus.INTERNAL_SERVER_ERROR);

    const unsupported = controllerWith(new Error('COMMANDLOG not supported on this database version'));
    expect(await statusOf(() => unsupported.resetCommandLog('slow', 'agent-1'))).toBe(HttpStatus.NOT_IMPLEMENTED);
  });
});
