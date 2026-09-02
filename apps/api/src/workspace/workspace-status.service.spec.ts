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
    });
    expect(await service.getStatus()).toEqual({
      mode: 'self-hosted',
      enabled: true,
      bootstrapped: false,
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
});
