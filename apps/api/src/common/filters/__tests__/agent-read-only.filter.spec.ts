import { HttpException, HttpStatus } from '@nestjs/common';
import { AgentReadOnlyError, isAgentReadOnlyError } from '../../errors/agent-read-only.error';
import { AgentReadOnlyFilter } from '../agent-read-only.filter';
import { MetricsController } from '../../../metrics/metrics.controller';

// A fake ArgumentsHost over a recording Fastify-style reply.
function httpHost() {
  const reply = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
  };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => reply, getRequest: () => ({}) }),
  };
  return { reply, host };
}

describe('AgentReadOnlyFilter', () => {
  it('answers 403 for the typed error', () => {
    const { reply, host } = httpHost();

    new AgentReadOnlyFilter().catch(new AgentReadOnlyError(), host as never);

    expect(reply.statusCode).toBe(403);
    expect(reply.body).toEqual({ statusCode: 403, code: 'AGENT_READ_ONLY', message: 'This agent connection is read-only.' });
  });

  it('answers 403 when a controller wrapped the error as its cause, keeping the wrapped message', () => {
    const { reply, host } = httpHost();
    const wrapped = new HttpException('Failed to reset ACL log: This agent connection is read-only.', HttpStatus.INTERNAL_SERVER_ERROR, { cause: new AgentReadOnlyError() });

    new AgentReadOnlyFilter().catch(wrapped, host as never);

    expect(reply.statusCode).toBe(403);
    expect(reply.body).toMatchObject({ code: 'AGENT_READ_ONLY', message: 'Failed to reset ACL log: This agent connection is read-only.' });
  });

  it('leaves other HttpExceptions to the base filter', () => {
    const { host } = httpHost();
    const filter = new AgentReadOnlyFilter();
    const base = jest.spyOn(Object.getPrototypeOf(AgentReadOnlyFilter.prototype), 'catch').mockImplementation(() => undefined);

    filter.catch(new HttpException('boom', HttpStatus.BAD_GATEWAY), host as never);

    expect(base).toHaveBeenCalledTimes(1);
    base.mockRestore();
  });
});

describe('isAgentReadOnlyError', () => {
  it('recognises the error directly and through an HttpException cause, nothing else', () => {
    expect(isAgentReadOnlyError(new AgentReadOnlyError())).toBe(true);
    expect(isAgentReadOnlyError(new HttpException('x', 500, { cause: new AgentReadOnlyError() }))).toBe(true);
    expect(isAgentReadOnlyError(new HttpException('This agent connection is read-only.', 500))).toBe(false);
    expect(isAgentReadOnlyError(new Error('This agent connection is read-only.'))).toBe(false);
  });
});

// The controllers' catch blocks must hand the cause on, or the filter never
// sees it. Every state-changing route of MetricsController is checked.
describe('MetricsController keeps the read-only cause on its wrapped errors', () => {
  function controller() {
    const rejects = jest.fn().mockRejectedValue(new AgentReadOnlyError());
    const service = { resetSlowLog: rejects, resetCommandLog: rejects, resetLatencyEvents: rejects, resetAclLog: rejects, killClient: rejects };
    return new MetricsController(service as never, {} as never, {} as never);
  }

  it.each([
    ['resetSlowLog', (c: MetricsController) => c.resetSlowLog('agent-1')],
    ['resetCommandLog', (c: MetricsController) => c.resetCommandLog('slow', 'agent-1')],
    ['resetLatencyEvents', (c: MetricsController) => c.resetLatencyEvents(undefined, 'agent-1')],
    ['resetAclLog', (c: MetricsController) => c.resetAclLog('agent-1')],
    ['killClient', (c: MetricsController) => c.killClient(undefined, '7', 'agent-1')],
  ])('%s', async (_name, call) => {
    const thrown = await call(controller()).then(() => null, (err: unknown) => err);
    expect(thrown).toBeInstanceOf(HttpException);
    expect(isAgentReadOnlyError(thrown)).toBe(true);
  });
});
