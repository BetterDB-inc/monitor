import { Tier } from '@betterdb/shared';
import { RetentionPolicyService, MS_PER_DAY } from '../retention-policy.service';

describe('RetentionPolicyService', () => {
  let originalCloudMode: string | undefined;

  beforeEach(() => {
    originalCloudMode = process.env.CLOUD_MODE;
    delete process.env.CLOUD_MODE;
  });

  afterEach(() => {
    if (originalCloudMode === undefined) {
      delete process.env.CLOUD_MODE;
    } else {
      process.env.CLOUD_MODE = originalCloudMode;
    }
  });

  const makeService = (localRetentionDays: number | null, tier?: Tier) => {
    const settingsService = {
      getCachedSettings: jest.fn().mockReturnValue({ localRetentionDays }),
    } as any;
    const licenseService = tier
      ? ({ getLicenseTier: jest.fn().mockReturnValue(tier) } as any)
      : undefined;
    return new RetentionPolicyService(settingsService, licenseService);
  };

  it('falls back to the community window when no license service is available', () => {
    expect(makeService(null).getRetentionDays()).toBe(7);
  });

  it('uses the license tier default when no local override is set', () => {
    expect(makeService(null, Tier.community).getRetentionDays()).toBe(7);
    expect(makeService(null, Tier.pro).getRetentionDays()).toBe(90);
    expect(makeService(null, Tier.enterprise).getRetentionDays()).toBe(365);
  });

  it('prefers the operator-configured local window over the tier default', () => {
    expect(makeService(14, Tier.pro).getRetentionDays()).toBe(14);
    expect(makeService(500, Tier.community).getRetentionDays()).toBe(500);
  });

  it('ignores invalid local windows', () => {
    expect(makeService(0, Tier.pro).getRetentionDays()).toBe(90);
    expect(makeService(-3, Tier.pro).getRetentionDays()).toBe(90);
    expect(makeService(NaN, Tier.pro).getRetentionDays()).toBe(90);
  });

  it('ignores the local override in cloud mode', () => {
    process.env.CLOUD_MODE = 'true';
    const service = makeService(14, Tier.pro);
    expect(service.getLocalRetentionDays()).toBeNull();
    expect(service.getRetentionDays()).toBe(90);
  });

  it('converts days to milliseconds', () => {
    expect(makeService(14, Tier.pro).getRetentionMs()).toBe(14 * MS_PER_DAY);
  });
});
