import type { BetterAuthInstance } from '../auth/better-auth.factory';
import { resolveWorkspaceConfig } from '../auth/workspace-config';
import { WorkspaceStatusService } from './workspace-status.service';

function authWithUsers(count: jest.Mock): BetterAuthInstance {
  return { $context: Promise.resolve({ adapter: { count } }) } as unknown as BetterAuthInstance;
}

describe('WorkspaceStatusService', () => {
  const config = resolveWorkspaceConfig({});

  it('keeps counting while the workspace is not bootstrapped', async () => {
    const count = jest.fn().mockResolvedValue(0);
    const service = new WorkspaceStatusService(config, authWithUsers(count));

    expect(await service.getStatus()).toEqual({
      mode: 'self-hosted',
      enabled: true,
      bootstrapped: false,
      broker: config.brokerEnabled,
    });
    expect(await service.getStatus()).toEqual({
      mode: 'self-hosted',
      enabled: true,
      bootstrapped: false,
      broker: config.brokerEnabled,
    });
    expect(count).toHaveBeenCalledTimes(2);
  });

  it('stops counting users once the workspace is bootstrapped', async () => {
    const count = jest.fn().mockResolvedValue(1);
    const service = new WorkspaceStatusService(config, authWithUsers(count));

    expect((await service.getStatus()).bootstrapped).toBe(true);
    expect(count).toHaveBeenCalledTimes(1);

    count.mockResolvedValue(0);
    expect((await service.getStatus()).bootstrapped).toBe(true);
    expect(count).toHaveBeenCalledTimes(1);
  });

  it('reports the broker as enabled in both the fresh and the bootstrapped branch', async () => {
    const enabled = { ...config, brokerEnabled: true };
    const count = jest.fn().mockResolvedValue(1);
    const service = new WorkspaceStatusService(enabled, authWithUsers(count));

    expect((await service.getStatus()).broker).toBe(true);
    expect((await service.getStatus()).broker).toBe(true);
  });

  it('reports the broker as off when AUTH_BROKER_DISABLED is set', async () => {
    const disabled = resolveWorkspaceConfig({ AUTH_BROKER_DISABLED: 'true' });
    const count = jest.fn().mockResolvedValue(0);
    const service = new WorkspaceStatusService(disabled, authWithUsers(count));

    expect((await service.getStatus()).broker).toBe(false);
  });
});
