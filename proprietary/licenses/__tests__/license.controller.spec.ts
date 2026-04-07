import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { LicenseController } from '../license.controller';

describe('LicenseController', () => {
  let controller: LicenseController;
  let licenseService: {
    activateLicenseKey: jest.Mock;
  };

  beforeEach(() => {
    licenseService = {
      activateLicenseKey: jest.fn(),
    };

    controller = new LicenseController(licenseService as any);
  });

  it('should return activation payload for a valid license key', async () => {
    licenseService.activateLicenseKey.mockResolvedValue({
      valid: true,
      tier: 'pro',
      expiresAt: null,
      error: undefined,
      customer: { id: 'cus_123', name: 'Acme', email: 'billing@acme.dev' },
    });

    const result = await controller.activate({ key: 'valid-license-key-12345' });

    expect(licenseService.activateLicenseKey).toHaveBeenCalledWith('valid-license-key-12345');
    expect(result).toMatchObject({
      valid: true,
      tier: 'pro',
      error: undefined,
      customer: { id: 'cus_123', name: 'Acme', email: 'billing@acme.dev' },
      activatedAt: expect.any(String),
    });
  });

  it('should throw BadRequestException with error payload for invalid keys', async () => {
    licenseService.activateLicenseKey.mockResolvedValue({
      valid: false,
      tier: 'community',
      expiresAt: null,
      error: 'Invalid license key',
    });

    await expect(controller.activate({ key: 'invalid-license-key-12345' })).rejects.toThrow(
      BadRequestException,
    );

    try {
      await controller.activate({ key: 'invalid-license-key-12345' });
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        valid: false,
        tier: 'community',
        error: 'Invalid license key',
      });
    }
  });

  it('should throw ServiceUnavailableException with error payload when validation is unreachable', async () => {
    licenseService.activateLicenseKey.mockResolvedValue({
      valid: false,
      tier: 'community',
      expiresAt: null,
      error: 'Validation failed',
    });

    await expect(controller.activate({ key: 'new-license-key-12345' })).rejects.toThrow(
      ServiceUnavailableException,
    );

    try {
      await controller.activate({ key: 'new-license-key-12345' });
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
        valid: false,
        tier: 'community',
        error: 'Validation failed',
      });
    }
  });
});
