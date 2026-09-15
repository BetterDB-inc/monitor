import { requireCloudAuth } from './cloud-auth-loader';

describe('requireCloudAuth', () => {
  it('returns the loaded module', () => {
    const loaded = { ProprietaryCloudAuthModule: class {} };
    expect(requireCloudAuth(() => loaded)).toBe(loaded);
  });

  it('fails startup when the proprietary module cannot be loaded', () => {
    const missing = new Error("Cannot find module '../../../proprietary/cloud-auth/cloud-auth.module'");
    let thrown: unknown;
    try {
      requireCloudAuth(() => {
        throw missing;
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'CLOUD_MODE is set but the proprietary cloud auth module is missing',
    );
    expect((thrown as Error).cause).toBe(missing);
  });
});
