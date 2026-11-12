import type { StoragePort } from '../../../common/interfaces/storage-port.interface';

// Slow/command log IDs are per node. A connection whose host fronts several
// nodes must be able to resume each node from that node's own last ID.
const slow = (id: number, host: string, runId = '') => ({
  id, timestamp: 1_700_000_000 + id, duration: 10_000, command: ['EVAL'], clientAddress: '', clientName: '',
  capturedAt: 1, sourceHost: host, sourcePort: 6379, sourceRunId: runId, connectionId: 'seed',
});
const cmd = (id: number, host: string, runId = '') => ({ ...slow(id, host, runId), type: 'slow' as const });

/** Latest-id lookups and log-source keys every storage adapter must agree on. Expects an empty store. */
export async function assertLogSourceTracking(storage: StoragePort): Promise<void> {
  await storage.saveSlowLogEntries([slow(40, '10.0.0.1'), slow(7, '10.0.0.2')], 'seed');
  await storage.saveCommandLogEntries([cmd(40, '10.0.0.1'), cmd(7, '10.0.0.2')], 'seed');
  expect(await storage.hasRunIdLogEntries('seed')).toBe(false);

  expect(await storage.getLatestSlowLogId('seed')).toBe(40);
  expect(await storage.getLatestSlowLogId('seed', { host: '10.0.0.2', port: 6379 })).toBe(7);
  expect(await storage.getLatestSlowLogId('seed', { host: '10.0.0.3', port: 6379 })).toBeNull();
  expect(await storage.getLatestCommandLogId('slow', 'seed')).toBe(40);
  expect(await storage.getLatestCommandLogId('slow', 'seed', { host: '10.0.0.2', port: 6379 })).toBe(7);
  expect(await storage.getLatestCommandLogId('slow', 'seed', { host: '10.0.0.2', port: 6380 })).toBeNull();

  // Without a connection filter the source still applies.
  expect(await storage.getLatestSlowLogId(undefined, { host: '10.0.0.2', port: 6379 })).toBe(7);
  expect(await storage.getLatestCommandLogId('slow', undefined, { host: '10.0.0.2', port: 6379 })).toBe(7);

  // With a run id the process is the key, whatever address reached it, and the
  // same id from another process on the same address is kept.
  await storage.saveSlowLogEntries([slow(90, '10.0.0.5', 'run-a'), slow(3, '10.0.0.5', 'run-b')], 'seed');
  await storage.saveCommandLogEntries([cmd(90, '10.0.0.5', 'run-a'), cmd(3, '10.0.0.5', 'run-b')], 'seed');
  expect(await storage.hasRunIdLogEntries('seed')).toBe(true);
  expect(await storage.hasRunIdLogEntries('other')).toBe(false);
  expect(await storage.saveSlowLogEntries([slow(3, '10.0.0.5', 'run-a')], 'seed')).toBe(1);
  expect(await storage.getLatestSlowLogId('seed', { host: '10.9.9.9', port: 1, runId: 'run-a' })).toBe(90);
  expect(await storage.getLatestSlowLogId('seed', { host: '10.0.0.5', port: 6379, runId: 'run-b' })).toBe(3);
  expect(await storage.getLatestCommandLogId('slow', 'seed', { host: '10.9.9.9', port: 1, runId: 'run-a' })).toBe(90);
  // Rows without a run id are not mixed into a run-id lookup, and vice versa.
  expect(await storage.getLatestSlowLogId('seed', { host: '10.0.0.1', port: 6379, runId: 'run-c' })).toBeNull();
  expect(await storage.getLatestSlowLogId('seed', { host: '10.0.0.5', port: 6379 })).toBeNull();

  // The same process read through another address is stored once.
  expect(await storage.saveSlowLogEntries([slow(90, '10.9.9.9', 'run-a')], 'seed')).toBe(0);
  expect(await storage.saveCommandLogEntries([cmd(90, '10.9.9.9', 'run-a')], 'seed')).toBe(0);

  // Reads return the run id the entry was stored with.
  const slowRows = await storage.getSlowLogEntries({ connectionId: 'seed', limit: 100 });
  expect(slowRows.find((e) => e.id === 90)?.sourceRunId).toBe('run-a');
  expect(slowRows.find((e) => e.id === 40)?.sourceRunId).toBe('');
  const cmdRows = await storage.getCommandLogEntries({ connectionId: 'seed', type: 'slow', limit: 100 });
  expect(cmdRows.find((e) => e.id === 90)?.sourceRunId).toBe('run-a');
}
