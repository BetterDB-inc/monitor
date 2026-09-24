import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CONNECTION_ID_HEADER } from '../../common/decorators';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { ExternalConnectionUnsupportedError } from '../external-connection-unsupported.error';
import { AllowExternalConnection, LiveConnectionGuard } from '../live-connection.guard';

interface RequestParts {
  params?: Record<string, unknown>;
  body?: unknown;
  query?: Record<string, unknown>;
}

function contextFor(
  handler: object,
  klass: object,
  connectionId?: string,
  parts: RequestParts = {},
): ExecutionContext {
  const headers = connectionId ? { [CONNECTION_ID_HEADER]: connectionId } : {};
  return {
    getHandler: () => handler,
    getClass: () => klass,
    switchToHttp: () => ({
      getRequest: () => ({ headers, ...parts }),
    }),
  } as unknown as ExecutionContext;
}

describe('LiveConnectionGuard', () => {
  let registry: { getConfig: jest.Mock };
  let guard: LiveConnectionGuard;

  beforeEach(() => {
    registry = { getConfig: jest.fn() };
    guard = new LiveConnectionGuard(registry as unknown as ConnectionRegistry, new Reflector());
  });

  it('throws for external connections with no opt-out metadata', () => {
    registry.getConfig.mockReturnValue({ connectionType: 'external' });
    const handler = function getInfo() {};
    const klass = class SomeController {};
    const context = contextFor(handler, klass, 'conn-1');

    expect(() => guard.canActivate(context)).toThrow(ExternalConnectionUnsupportedError);
  });

  it('allows external connections when the handler opts out', () => {
    registry.getConfig.mockReturnValue({ connectionType: 'external' });
    const handler = function getInfo() {};
    AllowExternalConnection()({}, 'getInfo', { value: handler } as PropertyDescriptor);
    const klass = class SomeController {};
    const context = contextFor(handler, klass, 'conn-1');

    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows external connections when the controller class opts out', () => {
    registry.getConfig.mockReturnValue({ connectionType: 'external' });
    const handler = function getInfo() {};
    class SomeController {}
    AllowExternalConnection()(SomeController);
    const context = contextFor(handler, SomeController, 'conn-1');

    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows non-external connections regardless of metadata', () => {
    registry.getConfig.mockReturnValue({ connectionType: 'direct' });
    const handler = function getInfo() {};
    const klass = class SomeController {};
    const context = contextFor(handler, klass, 'conn-1');

    expect(guard.canActivate(context)).toBe(true);
  });

  describe('explicit connection ids', () => {
    const configs: Record<string, { connectionType: 'external' | 'direct' }> = {
      'ext-1': { connectionType: 'external' },
      'direct-1': { connectionType: 'direct' },
    };
    const handler = function startSession() {};
    const klass = class MonitorLikeController {};

    beforeEach(() => {
      registry.getConfig.mockImplementation((id?: string) => configs[id ?? 'direct-1'] ?? null);
    });

    it('rejects an external connection named by a route param', () => {
      const context = contextFor(handler, klass, 'direct-1', { params: { connectionId: 'ext-1' } });

      expect(() => guard.canActivate(context)).toThrow(ExternalConnectionUnsupportedError);
    });

    it('rejects an external connection named in the request body', () => {
      const context = contextFor(handler, klass, 'direct-1', { body: { connectionId: 'ext-1' } });

      expect(() => guard.canActivate(context)).toThrow(ExternalConnectionUnsupportedError);
    });

    it('rejects an external connection named in the query string', () => {
      const context = contextFor(handler, klass, 'direct-1', { query: { connectionId: 'ext-1' } });

      expect(() => guard.canActivate(context)).toThrow(ExternalConnectionUnsupportedError);
    });

    it('lets an explicit direct connection through even when the header names an external one', () => {
      const context = contextFor(handler, klass, 'ext-1', { body: { connectionId: 'direct-1' } });

      expect(guard.canActivate(context)).toBe(true);
    });

    it('ignores a non-string body connectionId and falls back to the header', () => {
      const context = contextFor(handler, klass, 'ext-1', { body: { connectionId: 42 } });

      expect(() => guard.canActivate(context)).toThrow(ExternalConnectionUnsupportedError);
    });
  });
});
