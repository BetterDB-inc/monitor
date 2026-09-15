import {
  FAILED_CLOUD_AUTH_MESSAGE,
  MISSING_CLOUD_AUTH_MESSAGE,
  requireCloudAuth,
} from './cloud-auth-loader';

function thrownBy(load: () => unknown): Error {
  try {
    requireCloudAuth(load);
  } catch (error) {
    return error as Error;
  }
  throw new Error('requireCloudAuth did not throw');
}

describe('requireCloudAuth', () => {
  it('returns the loaded module', () => {
    const loaded = { ProprietaryCloudAuthModule: class {} };
    expect(requireCloudAuth(() => loaded)).toBe(loaded);
  });

  it('fails startup when the proprietary module cannot be found', () => {
    const missing = Object.assign(
      new Error("Cannot find module '../../../proprietary/cloud-auth/cloud-auth.module'"),
      { code: 'MODULE_NOT_FOUND' },
    );
    const thrown = thrownBy(() => {
      throw missing;
    });
    expect(thrown.message).toBe(MISSING_CLOUD_AUTH_MESSAGE);
    expect(thrown.cause).toBe(missing);
  });

  it('reports a load failure when the proprietary module throws while loading', () => {
    const broken = new Error('JWT_SECRET is required');
    const thrown = thrownBy(() => {
      throw broken;
    });
    expect(thrown.message).toBe(FAILED_CLOUD_AUTH_MESSAGE);
    expect(thrown.cause).toBe(broken);
  });
});
