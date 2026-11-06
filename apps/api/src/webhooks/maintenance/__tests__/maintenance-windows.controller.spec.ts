import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { RequestWithActor } from '../../../auth/guards/actor.guard';
import { MaintenanceWindowsController } from '../maintenance-windows.controller';
import type { MaintenanceWindowService } from '../maintenance-window.service';
import { CreateMaintenanceWindowDto, UpdateMaintenanceWindowDto } from '../maintenance-window.dto';

describe('MaintenanceWindowsController', () => {
  let service: { list: jest.Mock; get: jest.Mock; create: jest.Mock; update: jest.Mock; end: jest.Mock; delete: jest.Mock };
  let controller: MaintenanceWindowsController;

  beforeEach(() => {
    service = {
      list: jest.fn().mockResolvedValue([]),
      get: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({ id: 'mw-1' }),
      update: jest.fn().mockResolvedValue({}),
      end: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    controller = new MaintenanceWindowsController(service as unknown as MaintenanceWindowService);
  });

  it('lists with an optional, validated state filter', async () => {
    await controller.list();
    expect(service.list).toHaveBeenCalledWith(undefined);
    await controller.list('active');
    expect(service.list).toHaveBeenLastCalledWith('active');
    await expect(controller.list('paused')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('records the signed-in member as the creator', async () => {
    const dto = { name: 'Upgrade', endsAt: 2 } as CreateMaintenanceWindowDto;
    await controller.create(dto, { actor: { email: 'ops@example.com' } } as unknown as RequestWithActor);
    expect(service.create).toHaveBeenCalledWith(dto, 'ops@example.com');
  });

  it('records no creator when workspace auth is off', async () => {
    const dto = { name: 'Upgrade', endsAt: 2 } as CreateMaintenanceWindowDto;
    await controller.create(dto, { actor: null } as unknown as RequestWithActor);
    expect(service.create).toHaveBeenCalledWith(dto, null);
  });

  it('passes update, end and delete through by id', async () => {
    await controller.update('mw-1', { name: 'x' } as UpdateMaintenanceWindowDto);
    await controller.end('mw-1');
    await controller.delete('mw-1');
    expect(service.update).toHaveBeenCalledWith('mw-1', { name: 'x' });
    expect(service.end).toHaveBeenCalledWith('mw-1');
    expect(service.delete).toHaveBeenCalledWith('mw-1');
  });
});

describe('maintenance window DTO validation', () => {
  const errorsFor = async (cls: new () => object, body: Record<string, unknown>) =>
    (await validate(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true })).map(
      (error) => error.property,
    );

  it('accepts a minimal create body and a fully specified one', async () => {
    expect(await errorsFor(CreateMaintenanceWindowDto, { name: 'Upgrade', endsAt: 1_800_000_000_000 })).toEqual([]);
    expect(
      await errorsFor(CreateMaintenanceWindowDto, {
        name: 'Upgrade',
        reason: null,
        connectionId: null,
        events: ['instance.down', 'failover.started'],
        startsAt: 1_800_000_000_000,
        endsAt: 1_800_000_360_000,
      }),
    ).toEqual([]);
  });

  it('rejects a missing name or end, unknown events and unknown fields', async () => {
    expect(await errorsFor(CreateMaintenanceWindowDto, { endsAt: 1 })).toEqual(['name']);
    expect(await errorsFor(CreateMaintenanceWindowDto, { name: 'x' })).toEqual(['endsAt']);
    expect(await errorsFor(CreateMaintenanceWindowDto, { name: 'x', endsAt: 1, events: ['instance.sideways'] })).toEqual([
      'events',
    ]);
    expect(await errorsFor(CreateMaintenanceWindowDto, { name: 'x', endsAt: 1, silenceForever: true })).toEqual([
      'silenceForever',
    ]);
    expect(await errorsFor(CreateMaintenanceWindowDto, { name: '', endsAt: 1 })).toEqual(['name']);
    expect(await errorsFor(CreateMaintenanceWindowDto, { name: 'x'.repeat(121), endsAt: 1 })).toEqual(['name']);
    expect(await errorsFor(CreateMaintenanceWindowDto, { name: 'x', endsAt: 1.5 })).toEqual(['endsAt']);
  });

  it('rejects null for non-nullable update fields, and accepts an empty patch or a null reason', async () => {
    expect(await errorsFor(UpdateMaintenanceWindowDto, { name: null })).toEqual(['name']);
    expect(await errorsFor(UpdateMaintenanceWindowDto, { events: null })).toEqual(['events']);
    expect(await errorsFor(UpdateMaintenanceWindowDto, {})).toEqual([]);
    expect(await errorsFor(UpdateMaintenanceWindowDto, { reason: null })).toEqual([]);
  });

  it('does not let an update change the connection a window covers', async () => {
    expect(await errorsFor(UpdateMaintenanceWindowDto, { connectionId: 'other' })).toEqual(['connectionId']);
    expect(await errorsFor(UpdateMaintenanceWindowDto, { endsAt: 1_800_000_000_000, reason: null })).toEqual([]);
  });
});
