import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { DemoModeGuard } from './demo-mode.guard';

function makeContext(host: string, method: string, url: string): ExecutionContext {
  const req = { headers: { host }, method, url };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext;
}

describe('DemoModeGuard', () => {
  let guard: DemoModeGuard;
  const DEMO_HOST = 'demo.app.betterdb.com';

  beforeEach(() => {
    guard = new DemoModeGuard();
    process.env.DEMO_HOSTNAME = DEMO_HOST;
  });

  afterEach(() => {
    delete process.env.DEMO_HOSTNAME;
  });

  it('throws NotFoundException on demo host POST /connections', () => {
    const ctx = makeContext(DEMO_HOST, 'POST', '/api/connections');
    expect(() => guard.canActivate(ctx)).toThrow(NotFoundException);
  });

  it('passes on demo host GET /connections', () => {
    const ctx = makeContext(DEMO_HOST, 'GET', '/api/connections');
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('passes on non-demo host POST /connections', () => {
    const ctx = makeContext('myworkspace.app.betterdb.com', 'POST', '/api/connections');
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('throws NotFoundException on demo host GET /team', () => {
    const ctx = makeContext(DEMO_HOST, 'GET', '/api/team');
    expect(() => guard.canActivate(ctx)).toThrow(NotFoundException);
  });

  it('passes when DEMO_HOSTNAME is not set', () => {
    delete process.env.DEMO_HOSTNAME;
    const ctx = makeContext(DEMO_HOST, 'POST', '/api/connections');
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
