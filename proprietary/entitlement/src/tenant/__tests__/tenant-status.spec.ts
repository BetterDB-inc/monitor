import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { TenantController } from '../tenant.controller';

function makeController(tenant: any) {
  const tenantService = { getTenantBySubdomain: vi.fn().mockResolvedValue(tenant) };
  const controller = new TenantController(tenantService as any);
  return { controller, tenantService };
}

describe('TenantController.getTenantStatus', () => {
  it('reports ready=true only when status is ready', async () => {
    const { controller } = makeController({
      subdomain: 'acme',
      status: 'ready',
      statusMessage: null,
    });
    await expect(controller.getTenantStatus('acme')).resolves.toEqual({
      subdomain: 'acme',
      status: 'ready',
      ready: true,
      statusMessage: null,
    });
  });

  it('reports ready=false while provisioning (signup must keep polling)', async () => {
    const { controller } = makeController({
      subdomain: 'acme',
      status: 'provisioning',
      statusMessage: null,
    });
    await expect(controller.getTenantStatus('acme')).resolves.toMatchObject({
      status: 'provisioning',
      ready: false,
    });
  });

  it('throws 404 for unknown subdomain', async () => {
    const { controller } = makeController(null);
    await expect(controller.getTenantStatus('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
