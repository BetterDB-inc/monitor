import { cloudActor } from './cloud-actor';

const base = { userId: 'u1', email: 'o@example.com', subdomain: 'acme', tenantId: 't1' };

describe('cloudActor', () => {
  it('maps owner to an admin flagged as owner', () => {
    expect(cloudActor({ ...base, role: 'owner' })).toEqual({
      userId: 'u1',
      email: 'o@example.com',
      role: 'admin',
      isOwner: true,
      via: 'session',
      tokenId: null,
    });
  });

  it('maps admin and member', () => {
    expect(cloudActor({ ...base, role: 'admin' })).toMatchObject({ role: 'admin', isOwner: false });
    expect(cloudActor({ ...base, role: 'member' })).toMatchObject({
      role: 'member',
      isOwner: false,
    });
    expect(cloudActor({ ...base, role: 'viewer' })).toMatchObject({
      role: 'member',
      isOwner: false,
    });
  });
});
