import { ForbiddenException } from '@nestjs/common';
import { EntitlementClientService } from './entitlement-client.service';
import { WorkspaceController } from './workspace.controller';
import type { FastifyRequest } from 'fastify';

/**
 * GHSA-2rwf-9ffp-8pf2: the entitlement client authenticates with the shared
 * platform admin bearer, so every mutating call it makes MUST carry the
 * caller's tenantId (the server 404s on mismatch) and every id it
 * interpolates into a path MUST be URL-encoded (a crafted id must not be
 * able to rewrite the request path).
 */
describe('EntitlementClientService tenant scoping and encoding', () => {
  let client: EntitlementClientService;
  let fetchMock: jest.Mock;
  const realFetch = global.fetch;

  beforeEach(() => {
    process.env.ENTITLEMENT_API_URL = 'http://entitlement.internal';
    process.env.ENTITLEMENT_API_KEY = 'admin-token';
    client = new EntitlementClientService();
    fetchMock = jest.fn(async () => ({
      ok: true,
      text: async () => '{}',
    })) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.ENTITLEMENT_API_URL;
    delete process.env.ENTITLEMENT_API_KEY;
  });

  function requestedUrl(): string {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    return fetchMock.mock.calls[0][0] as string;
  }

  it('deleteUser carries the tenantId and encodes the id', async () => {
    await client.deleteUser('user/../admin', 'tenant-a');
    expect(requestedUrl()).toBe(
      'http://entitlement.internal/users/user%2F..%2Fadmin?tenantId=tenant-a',
    );
  });

  it('revokeInvitation carries the tenantId and encodes the id', async () => {
    await client.revokeInvitation('inv?x=1', 'tenant-a');
    expect(requestedUrl()).toBe(
      'http://entitlement.internal/invitations/inv%3Fx%3D1?tenantId=tenant-a',
    );
  });

  it('acceptInvitation encodes the id and appends tenantId when given', async () => {
    await client.acceptInvitation('inv-1', 'user-1', 'tenant-a');
    expect(requestedUrl()).toBe(
      'http://entitlement.internal/invitations/inv-1/accept?tenantId=tenant-a',
    );
  });

  it('getMembers encodes the tenant path segment', async () => {
    await client.getMembers('tenant/../other');
    expect(requestedUrl()).toBe(
      'http://entitlement.internal/users/by-tenant/tenant%2F..%2Fother',
    );
  });

  it('valkey instance calls encode the id path segment', async () => {
    await client.deleteValkeyInstance('vk/../x', 'tenant-a');
    expect(requestedUrl()).toBe(
      'http://entitlement.internal/valkey-instances/vk%2F..%2Fx?tenantId=tenant-a',
    );
  });
});

describe('WorkspaceController threads the caller tenant into mutations', () => {
  let previousTenantId: string | undefined;
  beforeEach(() => {
    previousTenantId = process.env.TENANT_ID;
    // Resolve tenant from the session, like cloud pods without the env.
    delete process.env.TENANT_ID;
  });
  afterEach(() => {
    if (previousTenantId === undefined) delete process.env.TENANT_ID;
    else process.env.TENANT_ID = previousTenantId;
  });

  function makeController(entitlementClient: Partial<EntitlementClientService>) {
    return new WorkspaceController(
      entitlementClient as EntitlementClientService,
      {} as never, // ActivityService: unused by these handlers
    );
  }

  function reqFor(cloudUser: Record<string, unknown>): FastifyRequest {
    return { cloudUser } as unknown as FastifyRequest;
  }

  const owner = { userId: 'owner-1', role: 'owner', tenantId: 'tenant-a' };

  it('removeMember passes the caller tenant, never a caller-chosen one', async () => {
    const deleteUser = jest.fn(async () => ({ deleted: true }));
    const controller = makeController({ deleteUser } as Partial<EntitlementClientService>);

    await controller.removeMember(reqFor(owner), 'user-b-from-another-tenant');

    expect(deleteUser).toHaveBeenCalledWith('user-b-from-another-tenant', 'tenant-a');
  });

  it('revokeInvitation passes the caller tenant', async () => {
    const revokeInvitation = jest.fn(async () => ({ status: 'revoked' }));
    const controller = makeController({ revokeInvitation } as Partial<EntitlementClientService>);

    await controller.revokeInvitation(reqFor(owner), 'inv-b');

    expect(revokeInvitation).toHaveBeenCalledWith('inv-b', 'tenant-a');
  });

  // Fail closed when no tenant can be resolved: with neither TENANT_ID nor a
  // session tenant, the handler must throw rather than send `?tenantId=` and
  // have the entitlement server's truthiness check run the mutation unscoped.
  const ownerNoTenant = { userId: 'owner-1', role: 'owner', tenantId: '' };

  it('removeMember throws on an empty tenant instead of calling entitlement', async () => {
    const deleteUser = jest.fn(async () => ({ deleted: true }));
    const controller = makeController({ deleteUser } as Partial<EntitlementClientService>);

    await expect(controller.removeMember(reqFor(ownerNoTenant), 'user-b')).rejects.toThrow(
      ForbiddenException,
    );
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('revokeInvitation throws on an empty tenant instead of calling entitlement', async () => {
    const revokeInvitation = jest.fn(async () => ({ status: 'revoked' }));
    const controller = makeController({ revokeInvitation } as Partial<EntitlementClientService>);

    await expect(controller.revokeInvitation(reqFor(ownerNoTenant), 'inv-b')).rejects.toThrow(
      ForbiddenException,
    );
    expect(revokeInvitation).not.toHaveBeenCalled();
  });
});
