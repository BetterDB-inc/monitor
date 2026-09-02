import type { WorkspaceStatus } from '@betterdb/shared';
import { SystemController } from './system.controller';
import { WorkspaceStatusService } from '../workspace/workspace-status.service';
import { createBetterAuth } from '../auth/better-auth.factory';
import { resolveWorkspaceConfig } from '../auth/workspace-config';

describe('GET /system/workspace', () => {
  it('reports disabled when no status service is provided and CLOUD_MODE is unset', async () => {
    const controller = new SystemController(null, null);
    const previous = process.env.CLOUD_MODE;
    delete process.env.CLOUD_MODE;
    const status: WorkspaceStatus = await controller.getWorkspaceStatus();
    process.env.CLOUD_MODE = previous;
    expect(status).toEqual({ mode: 'disabled', enabled: false, bootstrapped: false });
  });

  it('reports cloud when CLOUD_MODE=true and no status service is provided', async () => {
    const controller = new SystemController(null, null);
    const previous = process.env.CLOUD_MODE;
    process.env.CLOUD_MODE = 'true';
    const status = await controller.getWorkspaceStatus();
    process.env.CLOUD_MODE = previous;
    expect(status).toEqual({ mode: 'cloud', enabled: true, bootstrapped: true });
  });

  it('reports self-hosted with bootstrapped from the user count', async () => {
    const config = resolveWorkspaceConfig({ AUTH_PUBLIC_URL: 'http://localhost:3001' });
    const auth = await createBetterAuth({
      handle: { kind: 'memory' },
      secret: 's'.repeat(40),
      config,
    });
    const service = new WorkspaceStatusService(config, auth);
    const controller = new SystemController(null, service);
    expect(await controller.getWorkspaceStatus()).toEqual({
      mode: 'self-hosted',
      enabled: true,
      bootstrapped: false,
    });
    await auth.api.signUpEmail({
      body: { email: 'owner@example.com', password: 'correct horse battery', name: 'O' },
    });
    expect((await controller.getWorkspaceStatus()).bootstrapped).toBe(true);
  });
});
