/* eslint-disable @typescript-eslint/no-explicit-any */
import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { McpController } from '../mcp.controller';

describe('McpController', () => {
  let registry: { get: jest.Mock };
  let metricsService: { getHealthSummary: jest.Mock };
  let controller: McpController;

  beforeEach(() => {
    registry = {
      get: jest.fn().mockReturnValue({
        getInfoParsed: jest.fn().mockResolvedValue({ server: {} }),
      }),
    };
    metricsService = {
      getHealthSummary: jest.fn().mockResolvedValue({ status: 'ok' }),
    };

    controller = new McpController(
      registry as any,
      metricsService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  it('preserves not found errors from connection lookup', async () => {
    registry.get.mockImplementationOnce(() => {
      throw new NotFoundException("Connection 'missing' not found.");
    });

    await expect(controller.getInfo('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('preserves not found errors from services that resolve an instance id', async () => {
    metricsService.getHealthSummary.mockRejectedValueOnce(
      new NotFoundException("Connection 'missing' not found."),
    );

    await expect(controller.getHealth('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('still wraps non-http failures in a generic 500', async () => {
    registry.get.mockImplementationOnce(() => {
      throw new Error('socket closed');
    });

    try {
      await controller.getInfo('conn-1');
      throw new Error('Expected getInfo to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).message).toBe('Failed to get info');
      expect((error as HttpException).getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    }
  });
});
