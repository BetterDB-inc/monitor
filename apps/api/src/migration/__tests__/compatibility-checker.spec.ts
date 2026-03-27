import { buildInstanceMeta, checkCompatibility, InstanceMeta } from '../analysis/compatibility-checker';
import type { DatabaseCapabilities } from '../../common/interfaces/database-port.interface';

function makeMeta(overrides: Partial<InstanceMeta> = {}): InstanceMeta {
  return {
    dbType: 'valkey',
    version: '8.1.0',
    capabilities: { dbType: 'valkey', version: '8.1.0' } as DatabaseCapabilities,
    clusterEnabled: false,
    databases: [0],
    modules: [],
    maxmemoryPolicy: 'noeviction',
    hasAclUsers: false,
    persistenceMode: 'rdb',
    ...overrides,
  };
}

describe('compatibility-checker', () => {
  describe('buildInstanceMeta', () => {
    it('should parse INFO fields correctly', () => {
      const info: Record<string, unknown> = {
        cluster_enabled: '1',
        db0: 'keys=100,expires=10',
        db3: 'keys=50,expires=5',
        maxmemory_policy: 'allkeys-lru',
        rdb_last_save_time: '1700000000',
        aof_enabled: '1',
      };
      const capabilities: DatabaseCapabilities = {
        dbType: 'valkey',
        version: '8.1.0',
        hasCommandLog: true,
        hasSlotStats: false,
        hasClusterSlotStats: false,
        hasLatencyMonitor: true,
        hasAclLog: true,
        hasMemoryDoctor: true,
        hasConfig: true,
        hasVectorSearch: false,
      };

      const meta = buildInstanceMeta(info, capabilities, ['default', 'admin']);

      expect(meta.dbType).toBe('valkey');
      expect(meta.version).toBe('8.1.0');
      expect(meta.clusterEnabled).toBe(true);
      expect(meta.databases).toEqual(expect.arrayContaining([0, 3]));
      expect(meta.maxmemoryPolicy).toBe('allkeys-lru');
      expect(meta.hasAclUsers).toBe(true);
      expect(meta.persistenceMode).toBe('rdb+aof');
    });

    it('should default to db0 when no keyspace databases found', () => {
      const meta = buildInstanceMeta(
        {},
        { dbType: 'redis', version: '7.2.0' } as DatabaseCapabilities,
        ['default'],
      );
      expect(meta.databases).toEqual([0]);
    });

    it('should detect RDB-only persistence', () => {
      const meta = buildInstanceMeta(
        { rdb_last_save_time: '1700000000', aof_enabled: '0' },
        { dbType: 'valkey', version: '8.0.0' } as DatabaseCapabilities,
        [],
      );
      expect(meta.persistenceMode).toBe('rdb');
    });

    it('should detect AOF-only persistence', () => {
      const meta = buildInstanceMeta(
        { aof_enabled: '1' },
        { dbType: 'valkey', version: '8.0.0' } as DatabaseCapabilities,
        [],
      );
      expect(meta.persistenceMode).toBe('aof');
    });

    it('should detect no persistence', () => {
      const meta = buildInstanceMeta(
        {},
        { dbType: 'valkey', version: '8.0.0' } as DatabaseCapabilities,
        [],
      );
      expect(meta.persistenceMode).toBe('none');
    });

    it('should not flag ACL users when only default exists', () => {
      const meta = buildInstanceMeta(
        {},
        { dbType: 'valkey', version: '8.0.0' } as DatabaseCapabilities,
        ['default'],
      );
      expect(meta.hasAclUsers).toBe(false);
    });
  });

  describe('checkCompatibility', () => {
    it('should return no issues for Valkey→Valkey same version', () => {
      const source = makeMeta();
      const target = makeMeta();
      const issues = checkCompatibility(source, target, false);
      expect(issues).toEqual([]);
    });

    it('should return HFE warning when hfeDetected and target does not support HFE', () => {
      const source = makeMeta({ dbType: 'redis', version: '7.2.0', capabilities: { dbType: 'redis', version: '7.2.0' } as DatabaseCapabilities });
      const target = makeMeta({ dbType: 'valkey', version: '7.2.0', capabilities: { dbType: 'valkey', version: '7.2.0' } as DatabaseCapabilities });
      const issues = checkCompatibility(source, target, true);
      const hfeIssue = issues.find(i => i.category === 'hfe');
      expect(hfeIssue).toBeDefined();
      expect(hfeIssue!.severity).toBe('blocking');
    });

    it('should not flag HFE when target supports it (Valkey 8.1+)', () => {
      const source = makeMeta();
      const target = makeMeta({ dbType: 'valkey', version: '8.1.0' });
      const issues = checkCompatibility(source, target, true);
      const hfeIssue = issues.find(i => i.category === 'hfe');
      expect(hfeIssue).toBeUndefined();
    });

    it('should return modules blocking issue when source has modules target does not', () => {
      const source = makeMeta({ modules: ['search', 'json'] });
      const target = makeMeta({ modules: [] });
      const issues = checkCompatibility(source, target, false);
      const moduleIssues = issues.filter(i => i.category === 'modules');
      expect(moduleIssues).toHaveLength(2);
      expect(moduleIssues[0].severity).toBe('blocking');
    });

    it('should return multi_db blocking issue when source is multi-DB and target is cluster', () => {
      const source = makeMeta({ databases: [0, 1, 2] });
      const target = makeMeta({ clusterEnabled: true });
      const issues = checkCompatibility(source, target, false);
      const multiDbIssue = issues.find(i => i.category === 'multi_db' && i.severity === 'blocking');
      expect(multiDbIssue).toBeDefined();
    });

    it('should return multi_db warning when source multi-DB target standalone without matching DBs', () => {
      const source = makeMeta({ databases: [0, 1] });
      const target = makeMeta({ databases: [0] });
      const issues = checkCompatibility(source, target, false);
      const multiDbWarn = issues.find(i => i.category === 'multi_db' && i.severity === 'warning');
      expect(multiDbWarn).toBeDefined();
    });

    it('should return cluster_topology blocking issue for cluster→standalone', () => {
      const source = makeMeta({ clusterEnabled: true });
      const target = makeMeta({ clusterEnabled: false });
      const issues = checkCompatibility(source, target, false);
      const clusterIssue = issues.find(i => i.category === 'cluster_topology' && i.severity === 'blocking');
      expect(clusterIssue).toBeDefined();
    });

    it('should return cluster_topology warning for standalone→cluster', () => {
      const source = makeMeta({ clusterEnabled: false });
      const target = makeMeta({ clusterEnabled: true });
      const issues = checkCompatibility(source, target, false);
      const clusterIssue = issues.find(i => i.category === 'cluster_topology' && i.severity === 'warning');
      expect(clusterIssue).toBeDefined();
    });

    it('should return acl warning when source has ACL users and target does not', () => {
      const source = makeMeta({ hasAclUsers: true });
      const target = makeMeta({ hasAclUsers: false });
      const issues = checkCompatibility(source, target, false);
      const aclIssue = issues.find(i => i.category === 'acl');
      expect(aclIssue).toBeDefined();
      expect(aclIssue!.severity).toBe('warning');
    });

    it('should return persistence info when modes differ', () => {
      const source = makeMeta({ persistenceMode: 'rdb' });
      const target = makeMeta({ persistenceMode: 'aof' });
      const issues = checkCompatibility(source, target, false);
      const persistIssue = issues.find(i => i.category === 'persistence');
      expect(persistIssue).toBeDefined();
      expect(persistIssue!.severity).toBe('info');
    });

    it('should return type_direction blocking issue for Valkey→Redis', () => {
      const source = makeMeta({ dbType: 'valkey' });
      const target = makeMeta({ dbType: 'redis', capabilities: { dbType: 'redis', version: '7.2.0' } as DatabaseCapabilities });
      const issues = checkCompatibility(source, target, false);
      const dirIssue = issues.find(i => i.category === 'type_direction');
      expect(dirIssue).toBeDefined();
      expect(dirIssue!.severity).toBe('blocking');
    });

    it('should return eviction policy mismatch warning', () => {
      const source = makeMeta({ maxmemoryPolicy: 'noeviction' });
      const target = makeMeta({ maxmemoryPolicy: 'allkeys-lru' });
      const issues = checkCompatibility(source, target, false);
      const evictionIssue = issues.find(i => i.category === 'maxmemory_policy');
      expect(evictionIssue).toBeDefined();
      expect(evictionIssue!.severity).toBe('warning');
    });
  });
});
