import { describe, it, expect } from 'vitest';
import type { Connection } from '../../../../hooks/useConnection';
import { describeDirection, isPlanComplete, planBlock, preflightNotes } from '../preflight';

function conn(partial: Partial<Connection> & Pick<Connection, 'id'>): Connection {
  return {
    name: partial.id,
    host: '10.0.0.1',
    port: 6379,
    isConnected: true,
    capabilities: { dbType: 'redis', version: '7.2' },
    ...partial,
  };
}

const REDIS_72 = conn({ id: 'src', name: 'prod-cache-eu' });
const VALKEY_81 = conn({
  id: 'tgt',
  name: 'valkey-prod-01',
  capabilities: { dbType: 'valkey', version: '8.1' },
});

describe('describeDirection', () => {
  it('returns null until both endpoints are chosen', () => {
    expect(describeDirection(null, null)).toBeNull();
    expect(describeDirection(REDIS_72, null)).toBeNull();
    expect(describeDirection(null, VALKEY_81)).toBeNull();
  });

  it('returns null when either endpoint has not reported its capabilities', () => {
    const unknown = conn({ id: 'tgt', capabilities: undefined });
    expect(describeDirection(REDIS_72, unknown)).toBeNull();
    expect(describeDirection(unknown, VALKEY_81)).toBeNull();
  });

  it('labels a cross-engine move as an engine change', () => {
    expect(describeDirection(REDIS_72, VALKEY_81)).toEqual({
      label: 'Redis 7.2 → Valkey 8.1',
      kind: 'engine-change',
    });
  });

  it('labels a same-engine move to a newer version as an upgrade', () => {
    const older = conn({ id: 'a', capabilities: { dbType: 'valkey', version: '8.0' } });
    expect(describeDirection(older, VALKEY_81)).toEqual({
      label: 'Valkey 8.0 → Valkey 8.1',
      kind: 'version-upgrade',
    });
  });

  it('labels a same-engine move to an older version as a downgrade', () => {
    const older = conn({ id: 'b', capabilities: { dbType: 'redis', version: '6.2' } });
    expect(describeDirection(REDIS_72, older)).toEqual({
      label: 'Redis 7.2 → Redis 6.2',
      kind: 'version-downgrade',
    });
  });

  it('compares version segments numerically, not lexically', () => {
    const v9 = conn({ id: 'c', capabilities: { dbType: 'valkey', version: '9.0' } });
    const v10 = conn({ id: 'd', capabilities: { dbType: 'valkey', version: '10.0' } });
    expect(describeDirection(v9, v10)?.kind).toBe('version-upgrade');
    expect(describeDirection(v10, v9)?.kind).toBe('version-downgrade');
  });

  it('treats matching engine and version as identical', () => {
    const same = conn({ id: 'e', capabilities: { dbType: 'redis', version: '7.2' } });
    expect(describeDirection(REDIS_72, same)?.kind).toBe('identical');
  });

  it('ignores a trailing patch segment the other side does not report', () => {
    const patched = conn({ id: 'f', capabilities: { dbType: 'redis', version: '7.2.0' } });
    expect(describeDirection(REDIS_72, patched)?.kind).toBe('identical');
  });
});

describe('isPlanComplete', () => {
  it('needs both endpoints', () => {
    expect(isPlanComplete(null, null)).toBe(false);
    expect(isPlanComplete(REDIS_72, null)).toBe(false);
    expect(isPlanComplete(null, VALKEY_81)).toBe(false);
    expect(isPlanComplete(REDIS_72, VALKEY_81)).toBe(true);
  });
});

describe('planBlock', () => {
  it('does not report a block while the plan is still incomplete', () => {
    expect(planBlock(REDIS_72, null)).toBeNull();
  });

  it('blocks a migration whose source and target are the same connection', () => {
    expect(planBlock(REDIS_72, REDIS_72)).toBe('Source and target must be different connections.');
  });

  it('blocks a migration involving an agent-backed instance', () => {
    const agent = conn({ id: 'agent', connectionType: 'agent' });
    expect(planBlock(agent, VALKEY_81)).toContain('agent');
    expect(planBlock(REDIS_72, { ...VALKEY_81, connectionType: 'agent' })).toContain('agent');
  });

  it('does not block on an offline target — that is a warning, not a stop', () => {
    expect(planBlock(REDIS_72, { ...VALKEY_81, isConnected: false })).toBeNull();
  });

  it('allows a normal cross-engine plan', () => {
    expect(planBlock(REDIS_72, VALKEY_81)).toBeNull();
  });
});

describe('preflightNotes', () => {
  it('says nothing until both endpoints are chosen', () => {
    expect(preflightNotes(REDIS_72, null)).toEqual([]);
    expect(preflightNotes(null, null)).toEqual([]);
  });

  it('confirms reachability when both endpoints are connected', () => {
    const notes = preflightNotes(REDIS_72, VALKEY_81);
    const reachability = notes.find((note) => {
      return note.id === 'reachability';
    });
    expect(reachability?.tone).toBe('ok');
  });

  it('names the endpoint that is offline', () => {
    const notes = preflightNotes(REDIS_72, { ...VALKEY_81, isConnected: false });
    const offline = notes.find((note) => {
      return note.id === 'target-offline';
    });
    expect(offline?.tone).toBe('warning');
    expect(offline?.message).toContain('valkey-prod-01');
  });

  it('reports both endpoints when both are offline', () => {
    const notes = preflightNotes(
      { ...REDIS_72, isConnected: false },
      { ...VALKEY_81, isConnected: false },
    );
    const ids = notes.map((note) => {
      return note.id;
    });
    expect(ids).toContain('source-offline');
    expect(ids).toContain('target-offline');
    expect(ids).not.toContain('reachability');
  });

  it('raises the direction note to a warning on a version downgrade', () => {
    const older = conn({ id: 'old', capabilities: { dbType: 'redis', version: '6.2' } });
    const notes = preflightNotes(REDIS_72, older);
    const direction = notes.find((note) => {
      return note.id === 'direction';
    });
    expect(direction?.tone).toBe('warning');
  });

  it('keeps the direction note informational on an engine change', () => {
    const direction = preflightNotes(REDIS_72, VALKEY_81).find((note) => {
      return note.id === 'direction';
    });
    expect(direction?.tone).toBe('info');
  });

  it('omits the direction note when capabilities are unknown', () => {
    const unknown = conn({ id: 'unknown', capabilities: undefined });
    const ids = preflightNotes(REDIS_72, unknown).map((note) => {
      return note.id;
    });
    expect(ids).not.toContain('direction');
  });

  it('always states that analysis does not modify either instance', () => {
    const readOnly = preflightNotes(REDIS_72, VALKEY_81).find((note) => {
      return note.id === 'read-only';
    });
    expect(readOnly).toBeDefined();
    expect(readOnly?.message).toMatch(/modif/i);
  });
});
