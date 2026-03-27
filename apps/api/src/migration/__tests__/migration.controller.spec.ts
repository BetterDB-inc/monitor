import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MigrationController } from '../migration.controller';

describe('MigrationController', () => {
  let controller: MigrationController;
  let migrationService: Record<string, jest.Mock>;
  let executionService: Record<string, jest.Mock>;
  let validationService: Record<string, jest.Mock>;

  beforeEach(() => {
    migrationService = {
      startAnalysis: jest.fn().mockResolvedValue({ id: 'job-1', status: 'pending' }),
      getJob: jest.fn().mockReturnValue({ id: 'job-1', status: 'running', progress: 50 }),
      cancelJob: jest.fn().mockReturnValue(true),
    };

    executionService = {
      startExecution: jest.fn().mockResolvedValue({ id: 'exec-1', status: 'pending' }),
      getExecution: jest.fn().mockReturnValue({ id: 'exec-1', status: 'running' }),
      stopExecution: jest.fn().mockReturnValue(true),
    };

    validationService = {
      startValidation: jest.fn().mockResolvedValue({ id: 'val-1', status: 'pending' }),
      getValidation: jest.fn().mockReturnValue({ id: 'val-1', status: 'running' }),
      cancelValidation: jest.fn().mockReturnValue(true),
    };

    controller = new MigrationController(
      migrationService as any,
      executionService as any,
      validationService as any,
    );
  });

  describe('POST /analysis', () => {
    it('should reject same source and target connection', async () => {
      await expect(
        controller.startAnalysis({
          sourceConnectionId: 'conn-1',
          targetConnectionId: 'conn-1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject scanSampleSize below 1000', async () => {
      await expect(
        controller.startAnalysis({
          sourceConnectionId: 'conn-1',
          targetConnectionId: 'conn-2',
          scanSampleSize: 500,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject scanSampleSize above 50000', async () => {
      await expect(
        controller.startAnalysis({
          sourceConnectionId: 'conn-1',
          targetConnectionId: 'conn-2',
          scanSampleSize: 100000,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should accept valid request and return job ID', async () => {
      const result = await controller.startAnalysis({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
      });

      expect(result).toEqual({ id: 'job-1', status: 'pending' });
      expect(migrationService.startAnalysis).toHaveBeenCalled();
    });

    it('should accept valid scanSampleSize', async () => {
      const result = await controller.startAnalysis({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        scanSampleSize: 5000,
      });

      expect(result).toEqual({ id: 'job-1', status: 'pending' });
    });

    it('should reject missing sourceConnectionId', async () => {
      await expect(
        controller.startAnalysis({
          sourceConnectionId: '',
          targetConnectionId: 'conn-2',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject missing targetConnectionId', async () => {
      await expect(
        controller.startAnalysis({
          sourceConnectionId: 'conn-1',
          targetConnectionId: '',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('GET /analysis/:id', () => {
    it('should return 404 for unknown ID', () => {
      migrationService.getJob.mockReturnValue(undefined);

      expect(() => controller.getJob('nonexistent')).toThrow(NotFoundException);
    });

    it('should return the job result for a valid ID', () => {
      const result = controller.getJob('job-1');

      expect(result).toEqual({ id: 'job-1', status: 'running', progress: 50 });
    });
  });

  describe('DELETE /analysis/:id', () => {
    it('should return 404 when job not found', () => {
      migrationService.cancelJob.mockReturnValue(false);

      expect(() => controller.cancelJob('nonexistent')).toThrow(NotFoundException);
    });

    it('should return cancelled: true on success', () => {
      const result = controller.cancelJob('job-1');
      expect(result).toEqual({ cancelled: true });
    });
  });

  describe('POST /execution', () => {
    it('should reject same source and target', async () => {
      await expect(
        controller.startExecution({
          sourceConnectionId: 'conn-1',
          targetConnectionId: 'conn-1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject invalid mode', async () => {
      await expect(
        controller.startExecution({
          sourceConnectionId: 'conn-1',
          targetConnectionId: 'conn-2',
          mode: 'invalid' as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should accept valid request', async () => {
      const result = await controller.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'command',
      });

      expect(result).toEqual({ id: 'exec-1', status: 'pending' });
    });

    it('should reject missing sourceConnectionId', async () => {
      await expect(
        controller.startExecution({
          sourceConnectionId: '',
          targetConnectionId: 'conn-2',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('POST /validation', () => {
    it('should accept valid body and return job ID', async () => {
      const result = await controller.startValidation({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
      });

      expect(result).toEqual({ id: 'val-1', status: 'pending' });
    });

    it('should reject same source and target', async () => {
      await expect(
        controller.startValidation({
          sourceConnectionId: 'conn-1',
          targetConnectionId: 'conn-1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject missing sourceConnectionId', async () => {
      await expect(
        controller.startValidation({
          sourceConnectionId: '',
          targetConnectionId: 'conn-2',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('GET /validation/:id', () => {
    it('should return 404 for unknown ID', () => {
      validationService.getValidation.mockReturnValue(undefined);

      expect(() => controller.getValidation('nonexistent')).toThrow(NotFoundException);
    });
  });

  describe('DELETE /validation/:id', () => {
    it('should return 404 when job not found', () => {
      validationService.cancelValidation.mockReturnValue(false);

      expect(() => controller.cancelValidation('nonexistent')).toThrow(NotFoundException);
    });
  });
});
