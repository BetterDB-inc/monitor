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

  describe('self-hosted', () => {
    it('returns null when no local window is configured — keep forever', () => {
      expect(makeService(null).getRetentionDays()).toBeNull();
      expect(makeService(null, Tier.pro).getRetentionDays()).toBeNull();
      expect(makeService(null, Tier.enterprise).getRetentionMs()).toBeNull();
    });

    it('uses the operator-configured window regardless of tier', () => {
      expect(makeService(14, Tier.pro).getRetentionDays()).toBe(14);
      expect(makeService(500).getRetentionDays()).toBe(500);
    });

    it('treats invalid local windows as unset', () => {
      expect(makeService(0, Tier.pro).getRetentionDays()).toBeNull();
      expect(makeService(-3).getRetentionDays()).toBeNull();
      expect(makeService(NaN).getRetentionDays()).toBeNull();
    });

    it('converts days to milliseconds', () => {
      expect(makeService(14).getRetentionMs()).toBe(14 * MS_PER_DAY);
    });
  });

  describe('cloud mode', () => {
    beforeEach(() => {
      process.env.CLOUD_MODE = 'true';
    });

    it('uses the license tier window', () => {
      expect(makeService(null, Tier.community).getRetentionDays()).toBe(7);
      expect(makeService(null, Tier.pro).getRetentionDays()).toBe(90);
      expect(makeService(null, Tier.enterprise).getRetentionDays()).toBe(365);
    });

    it('falls back to the community window without a license service', () => {
      expect(makeService(null).getRetentionDays()).toBe(7);
    });

    it('ignores the local override', () => {
      const service = makeService(14, Tier.pro);
      expect(service.getLocalRetentionDays()).toBeNull();
      expect(service.getRetentionDays()).toBe(90);
    });
  });
});
