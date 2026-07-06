/* eslint-disable @typescript-eslint/no-explicit-any */
import { HttpException } from '@nestjs/common';
import { McpController } from '../mcp.controller';

describe('McpController', () => {
  let client: { getInfoParsed: jest.Mock };
  let registry: { get: jest.Mock };
  let controller: McpController;

  beforeEach(() => {
    client = {
      getInfoParsed: jest.fn().mockResolvedValue({ memory: { used_memory: '1024' } }),
    };
    registry = {
      get: jest.fn().mockReturnValue(client),
    };

    controller = new McpController(
      registry as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  it('passes the requested INFO section to the connection client', async () => {
    await expect(controller.getInfo('conn-1', 'memory')).resolves.toEqual({
      memory: { used_memory: '1024' },
    });

    expect(registry.get).toHaveBeenCalledWith('conn-1');
    expect(client.getInfoParsed).toHaveBeenCalledWith(['memory']);
  });

  it('requests all INFO sections when no section is provided', async () => {
    await controller.getInfo('conn-1', undefined);

    expect(client.getInfoParsed).toHaveBeenCalledWith(undefined);
  });

  it('wraps INFO lookup failures in an HTTP exception', async () => {
    client.getInfoParsed.mockRejectedValueOnce(new Error('connection failed'));

    await expect(controller.getInfo('conn-1', 'stats')).rejects.toBeInstanceOf(HttpException);
  });
});
