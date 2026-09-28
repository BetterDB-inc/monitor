import { describe, expect, it } from 'vitest';
import type { Connection } from '../../hooks/useConnection';
import { deleteConfirmation, disableConfirmation, showsAutoRegisterToggle } from './autoRegisterCopy';

const seed: Connection = { id: 's', name: 'prod', host: 'h', port: 7001, isConnected: true, capabilities: { dbType: 'valkey', version: '8', clusterEnabled: true } };
const auto = (id: string, retiredAt?: number): Connection => ({ id, name: id, host: 'h', port: 1, isConnected: true, membership: { seedId: 's', nodeId: id, origin: 'auto', retiredAt } });
const adopted: Connection = { id: 'm', name: 'mine', host: 'h', port: 2, isConnected: true, membership: { seedId: 's', nodeId: 'm', origin: 'adopted' } };

describe('auto-register copy', () => {
  it('warns that deleting a seed deletes its auto nodes and keeps adopted ones', () => {
    expect(deleteConfirmation(seed, [seed, auto('a'), auto('b', 1), adopted])).toBe(
      'Delete prod? This also deletes 2 auto-registered nodes; adopted connections are kept.',
    );
  });

  it('warns that a deleted auto node comes back', () => {
    expect(deleteConfirmation(auto('a'), [seed, auto('a')])).toBe(
      'Delete a? It will be registered again on the next sync unless auto-registration is turned off on prod.',
    );
  });

  it('uses the plain prompt for other connections', () => {
    expect(deleteConfirmation(adopted, [seed, adopted])).toBe('Are you sure you want to delete this connection?');
  });

  it('counts active auto nodes when disabling', () => {
    expect(disableConfirmation(seed, [seed, auto('a'), auto('b', 1), adopted])).toBe(
      '1 auto-registered node will be retired. Its history is kept.',
    );
  });

  it('shows the toggle only on cluster seeds', () => {
    expect(showsAutoRegisterToggle(seed)).toBe(true);
    expect(showsAutoRegisterToggle({ ...seed, capabilities: { dbType: 'valkey', version: '8', clusterEnabled: false } })).toBe(false);
    expect(showsAutoRegisterToggle(auto('a'))).toBe(false);
    expect(showsAutoRegisterToggle({ ...seed, connectionType: 'external' })).toBe(false);
  });
});
