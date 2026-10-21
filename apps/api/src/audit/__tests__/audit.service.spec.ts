import { AUDIT_STATS_PERIODIC_REFRESH_MS, AuditService } from '../audit.service';
import { AuditStatsCacheService } from '../audit-stats-cache.service';

describe('AuditService', () => {
  it('keeps Sentinel connections in the scheduled audit', () => {
    const service = Object.create(AuditService.prototype) as unknown as { pollsSentinels(): boolean };
    expect(service.pollsSentinels()).toBe(true);
  });

  describe('ACL stats cache', () => {
    const stats = { totalEntries: 3, entriesByReason: { auth: 3 }, entriesByUser: { bob: 3 } };
    let storage: { getAuditStats: jest.Mock; saveAclEntries: jest.Mock };
    let cache: AuditStatsCacheService;
    let service: AuditService;
    let aclLog: jest.Mock;

    beforeEach(() => {
      storage = {
        getAuditStats: jest.fn().mockResolvedValue(stats),
        saveAclEntries: jest.fn().mockResolvedValue(1),
      };
      cache = new AuditStatsCacheService();
      service = new AuditService(
        {} as never,
        storage as never,
        { startPollTimer: () => () => undefined, incrementPollCounter: jest.fn() } as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        cache,
        undefined,
      );
      aclLog = jest.fn().mockResolvedValue([]);
    });

    const poll = () =>
      service['pollConnection']({
        connectionId: 'c1',
        connectionName: 'c1',
        host: 'h',
        port: 1,
        client: { getCapabilities: () => ({ hasAclLog: true }), getAclLog: aclLog } as never,
      });

    it('fills the cache on the first poll even with no new entries, then only after saves', async () => {
      await poll();
      expect(cache.get('c1')).toEqual(stats);
      expect(storage.getAuditStats).toHaveBeenCalledWith(undefined, undefined, 'c1');

      await poll();
      expect(storage.getAuditStats).toHaveBeenCalledTimes(1);

      aclLog.mockResolvedValue([
        { count: 1, reason: 'auth', context: 'toplevel', object: 'AUTH', username: 'bob', ageSeconds: 1, clientInfo: '', timestampCreated: 10, timestampLastUpdated: 10 },
      ]);
      await poll();
      expect(storage.saveAclEntries).toHaveBeenCalledTimes(1);
      expect(storage.getAuditStats).toHaveBeenCalledTimes(2);
    });

    it('refreshes without new entries once the cached stats are older than the periodic interval', async () => {
      const now = 1_700_000_000_000;
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
      try {
        cache.set('c1', { ...stats, totalEntries: 9 } as never, now - AUDIT_STATS_PERIODIC_REFRESH_MS);
        await poll();
        expect(storage.saveAclEntries).not.toHaveBeenCalled();
        expect(storage.getAuditStats).toHaveBeenCalledTimes(1);
        expect(cache.get('c1')).toEqual(stats);
        expect(cache.getRefreshedAt('c1')).toBe(now);
      } finally {
        clock.mockRestore();
      }
    });

    it('does not refresh without new entries while the cached stats are fresh', async () => {
      const now = 1_700_000_000_000;
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const cached = { ...stats, totalEntries: 9 } as never;
        cache.set('c1', cached, now - AUDIT_STATS_PERIODIC_REFRESH_MS + 1);
        await poll();
        expect(storage.getAuditStats).not.toHaveBeenCalled();
        expect(cache.get('c1')).toEqual(cached);
      } finally {
        clock.mockRestore();
      }
    });

    it('fills the cache from stored totals even when ACL LOG fails on every poll, and still rethrows', async () => {
      const now = 1_700_000_000_000;
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
      try {
        jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
        aclLog.mockRejectedValue(new Error('connection reset'));
        await expect(poll()).rejects.toThrow('connection reset');
        expect(cache.get('c1')).toEqual(stats);
        expect(storage.getAuditStats).toHaveBeenCalledTimes(1);

        // Fresh cache: no refresh on the next failing poll.
        await expect(poll()).rejects.toThrow('connection reset');
        expect(storage.getAuditStats).toHaveBeenCalledTimes(1);

        // Due again: the failing poll still refreshes.
        clock.mockReturnValue(now + AUDIT_STATS_PERIODIC_REFRESH_MS);
        storage.getAuditStats.mockResolvedValue({ ...stats, totalEntries: 4 });
        await expect(poll()).rejects.toThrow('connection reset');
        expect(storage.getAuditStats).toHaveBeenCalledTimes(2);
        expect(cache.get('c1')).toEqual({ ...stats, totalEntries: 4 });
        expect(storage.saveAclEntries).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
      }
    });

    it('drops the cached stats when the connection is removed', async () => {
      await poll();
      service['onConnectionRemoved']('c1');
      expect(cache.get('c1')).toBeNull();
    });
  });
});
