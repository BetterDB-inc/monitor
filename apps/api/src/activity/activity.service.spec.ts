import { BadRequestException, Logger } from '@nestjs/common';
import { MemoryAdapter } from '../storage/adapters/memory.adapter';
import { encodeActivityCursor } from './activity-cursor';
import { ActivityService, INVALID_CURSOR_MESSAGE, toActivityActor } from './activity.service';

const actor = toActivityActor({
  userId: 'u1',
  email: 'owner@example.com',
  role: 'admin',
  isOwner: true,
  via: 'session',
  tokenId: null,
});

describe('ActivityService', () => {
  let storage: MemoryAdapter;
  let service: ActivityService;

  beforeEach(async () => {
    storage = new MemoryAdapter();
    await storage.initialize();
    service = new ActivityService(storage, { retentionDays: 90 });
  });

  afterEach(async () => {
    await storage.close();
  });

  it('records an event with an id and timestamp', async () => {
    const before = Date.now();
    await service.record({
      actor,
      action: 'connection.create',
      statusCode: 201,
      ip: '127.0.0.1',
      connectionId: 'c1',
      targetType: 'connection',
      targetId: 'c1',
      details: { method: 'POST', path: '/connections' },
    });
    const page = await service.list({});
    expect(page.items).toHaveLength(1);
    const [item] = page.items;
    expect(item.id).toHaveLength(36);
    expect(item.occurredAt).toBeGreaterThanOrEqual(before);
    expect(item.actorUserId).toBe('u1');
    expect(item.actorEmail).toBe('owner@example.com');
    expect(item.actorVia).toBe('session');
    expect(item.tokenId).toBeNull();
    expect(item.action).toBe('connection.create');
    expect(item.targetType).toBe('connection');
    expect(item.targetId).toBe('c1');
    expect(item.connectionId).toBe('c1');
    expect(item.statusCode).toBe(201);
    expect(item.details).toEqual({ method: 'POST', path: '/connections' });
    expect(page.nextCursor).toBeNull();
  });

  it('defaults optional fields to null and empty details', async () => {
    await service.record({ actor, action: 'auth.login', statusCode: 200, ip: '::1' });
    const [item] = (await service.list({})).items;
    expect(item.targetType).toBeNull();
    expect(item.targetId).toBeNull();
    expect(item.connectionId).toBeNull();
    expect(item.details).toEqual({});
  });

  it('swallows repository failures and logs a warning', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      return undefined;
    });
    jest.spyOn(storage.getActivityRepository(), 'insert').mockRejectedValueOnce(new Error('disk'));
    await expect(
      service.record({ actor, action: 'auth.login', statusCode: 200, ip: '::1' }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('auth.login'));
    warn.mockRestore();
  });

  it('pages with an opaque cursor and clamps the page size to 100', async () => {
    for (let i = 0; i < 3; i += 1) {
      await service.record({ actor, action: `a${i}`, statusCode: 200, ip: '::1' });
    }
    const first = await service.list({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const repository = storage.getActivityRepository();
    const list = jest.spyOn(repository, 'list');
    await service.list({ limit: 500 });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    await service.list({});
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 100 }));
  });

  it('rejects a malformed cursor with 400', async () => {
    await expect(service.list({ cursor: 'zzz!' })).rejects.toThrow(BadRequestException);
    await expect(service.list({ cursor: 'zzz!' })).rejects.toThrow(INVALID_CURSOR_MESSAGE);
    expect(encodeActivityCursor({ occurredAt: 1, id: 'x' })).not.toBe('zzz!');
  });

  it('passes filters through to the repository', async () => {
    const list = jest.spyOn(storage.getActivityRepository(), 'list');
    await service.list({ actorUserId: 'u1', from: 10, to: 20, action: 'auth.login' });
    expect(list).toHaveBeenCalledWith({
      actorUserId: 'u1',
      from: 10,
      to: 20,
      action: 'auth.login',
      before: undefined,
      limit: 100,
    });
  });

  it('prunes rows older than the retention window', async () => {
    const repository = storage.getActivityRepository();
    const prune = jest.spyOn(repository, 'prune').mockResolvedValue(3);
    const now = 100 * 24 * 60 * 60 * 1000;
    expect(await service.prune(now)).toBe(3);
    expect(prune).toHaveBeenCalledWith(now - 90 * 24 * 60 * 60 * 1000);
  });
});
