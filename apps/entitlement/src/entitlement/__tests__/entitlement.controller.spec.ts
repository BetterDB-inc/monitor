import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { EntitlementController } from '../entitlement.controller';
import { EntitlementService } from '../entitlement.service';
import { Tier, EntitlementRequest } from '@betterdb/shared';

describe('EntitlementController', () => {
  let controller: EntitlementController;
  let service: jest.Mocked<EntitlementService>;

  beforeEach(async () => {
    const mockService = {
      validateLicense: jest.fn(),
      handleKeylessInstance: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EntitlementController],
      providers: [
        {
          provide: EntitlementService,
          useValue: mockService,
        },
      ],
    }).compile();

    controller = module.get<EntitlementController>(EntitlementController);
    service = module.get(EntitlementService);
  });

  describe('validate', () => {
    it('should accept keyless requests and route to handleKeylessInstance', async () => {
      const keylessRequest: EntitlementRequest = {
        instanceId: 'test-instance-id',
        eventType: 'license_check',
        stats: {
          version: '1.0.0',
          platform: 'linux',
          arch: 'x64',
          nodeVersion: 'v20.0.0',
        },
      };

      service.handleKeylessInstance.mockResolvedValue({
        valid: true,
        tier: Tier.community,
        expiresAt: null,
      });

      const result = await controller.validate(keylessRequest);

      expect(service.handleKeylessInstance).toHaveBeenCalledWith(keylessRequest);
      expect(service.validateLicense).not.toHaveBeenCalled();
      expect(result.tier).toBe(Tier.community);
    });

    it('should accept requests with empty string licenseKey', async () => {
      const request: EntitlementRequest = {
        licenseKey: '',
        instanceId: 'test-instance-id',
        eventType: 'license_check',
        stats: {},
      };

      service.handleKeylessInstance.mockResolvedValue({
        valid: true,
        tier: Tier.community,
        expiresAt: null,
      });

      await controller.validate(request);

      expect(service.handleKeylessInstance).toHaveBeenCalledWith(request);
    });

    it('should validate license key format only when key is provided', async () => {
      const request: EntitlementRequest = {
        licenseKey: 'short', // Too short
        instanceId: 'test-instance-id',
        eventType: 'license_check',
        stats: {},
      };

      await expect(controller.validate(request)).rejects.toThrow(BadRequestException);
    });

    it('should route valid license keys to validateLicense', async () => {
      const request: EntitlementRequest = {
        licenseKey: 'valid-license-key-12345',
        instanceId: 'test-instance-id',
        eventType: 'license_check',
        stats: {},
      };

      service.validateLicense.mockResolvedValue({
        valid: true,
        tier: Tier.pro,
        expiresAt: null,
      });

      const result = await controller.validate(request);

      expect(service.validateLicense).toHaveBeenCalledWith(request);
      expect(service.handleKeylessInstance).not.toHaveBeenCalled();
      expect(result.tier).toBe(Tier.pro);
    });

    it('should reject license keys that are too long', async () => {
      const request: EntitlementRequest = {
        licenseKey: 'a'.repeat(101), // Too long
        instanceId: 'test-instance-id',
        eventType: 'license_check',
        stats: {},
      };

      await expect(controller.validate(request)).rejects.toThrow(BadRequestException);
    });
  });
});
