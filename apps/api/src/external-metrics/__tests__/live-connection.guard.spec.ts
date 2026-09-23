import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CONNECTION_ID_HEADER } from '../../common/decorators';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { ExternalConnectionUnsupportedError } from '../external-connection-unsupported.error';
import { AllowExternalConnection, LiveConnectionGuard } from '../live-connection.guard';

function contextFor(handler: object, klass: object, connectionId?: string): ExecutionContext {
  const headers = connectionId ? { [CONNECTION_ID_HEADER]: connectionId } : {};
  return {
    getHandler: () => handler,
    getClass: () => klass,
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
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
});
