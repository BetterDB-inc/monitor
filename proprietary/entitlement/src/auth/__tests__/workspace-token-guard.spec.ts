import { describe, it, expect, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AuthController } from '../auth.controller';

function makeController(user: any) {
  const userService = { getUserByEmail: vi.fn().mockResolvedValue(user) };
  const authService = { generateWorkspaceToken: vi.fn().mockReturnValue('signed-token') };
  const controller = new AuthController(authService as any, userService as any);
  return { controller, authService };
}

const baseUser = {
  id: 'u1',
  email: 'a@b.com',
  tenantId: 't1',
  role: 'owner',
};

describe('AuthController.generateWorkspaceToken readiness gate', () => {
  it('throws 404 when user is unknown', async () => {
    const { controller } = makeController(null);
    await expect(controller.generateWorkspaceToken({ email: 'x@y.com' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws 409 while tenant is still provisioning (no early redirect)', async () => {
    const { controller, authService } = makeController({
      ...baseUser,
      tenant: { subdomain: 'acme', status: 'provisioning' },
    });
    await expect(
      controller.generateWorkspaceToken({ email: baseUser.email }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(authService.generateWorkspaceToken).not.toHaveBeenCalled();
  });

  it('mints a token once tenant is ready', async () => {
    const { controller, authService } = makeController({
      ...baseUser,
      tenant: { subdomain: 'acme', status: 'ready' },
    });
    await expect(controller.generateWorkspaceToken({ email: baseUser.email })).resolves.toEqual({
      token: 'signed-token',
      subdomain: 'acme',
    });
    expect(authService.generateWorkspaceToken).toHaveBeenCalledOnce();
  });
});
