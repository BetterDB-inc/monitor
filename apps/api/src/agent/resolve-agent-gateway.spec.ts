import { resolveAgentGateway } from './resolve-agent-gateway';

describe('resolveAgentGateway', () => {
  const fakeGateway = { handleUpgrade: () => undefined };
  // Stub the proprietary require so tests never touch the real module.
  const requireGateway = () => ({ AgentGateway: Symbol('AgentGateway') });

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('returns null under WORKSPACE_DISABLED without ever calling app.get', () => {
    const get = jest.fn();
    expect(resolveAgentGateway({ get }, 'disabled', requireGateway)).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('returns null (does not throw) when the provider is absent in self-hosted mode', () => {
    // Regression for the v0.45.0 crash and the edge case Petar raised: if the
    // agent module failed to load, app.get throws UnknownElementException. The
    // lookup must degrade to null rather than exit the process.
    const get = jest.fn(() => {
      throw new Error('Nest could not find AgentGateway element');
    });
    expect(resolveAgentGateway({ get }, 'self-hosted', requireGateway)).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('returns the gateway when the provider is registered', () => {
    const get = jest.fn(() => fakeGateway);
    expect(resolveAgentGateway({ get }, 'self-hosted', requireGateway)).toBe(fakeGateway);
  });

  it('returns null when the proprietary agent code is not built (require throws)', () => {
    const get = jest.fn();
    const requireThrows = () => {
      throw new Error("Cannot find module '../../../proprietary/agent/agent-gateway'");
    };
    expect(resolveAgentGateway({ get }, 'cloud', requireThrows)).toBeNull();
  });
});
