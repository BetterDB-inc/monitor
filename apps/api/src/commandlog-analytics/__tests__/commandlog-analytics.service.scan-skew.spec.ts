import { CommandLogAnalyticsService } from '../commandlog-analytics.service';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../../connections/runtime-capability-tracker.service';
import { StoragePort, StoredCommandLogEntry } from '../../common/interfaces/storage-port.interface';

describe('CommandLogAnalyticsService getScanSkewAnalysis', () => {
  const skewedEntry = (id: number): StoredCommandLogEntry => {
    return {
      id,
      timestamp: 1_700_000_000 + id,
      duration: 5_000_000,
      command: ['SSCAN', 'recroom:todo:redo', '3112', 'COUNT', '1'],
      clientAddress: '127.0.0.1:50000',
      clientName: 'app',
      type: 'large-reply',
      capturedAt: 1_700_000_000_000,
      sourceHost: 'localhost',
      sourcePort: 6379,
    };
  };

  let storage: { getCommandLogEntries: jest.Mock };
  let service: CommandLogAnalyticsService;

  beforeEach(() => {
    storage = { getCommandLogEntries: jest.fn().mockResolvedValue([skewedEntry(1), skewedEntry(2)]) };
    service = new CommandLogAnalyticsService(
      { list: jest.fn().mockReturnValue([]) } as unknown as ConnectionRegistry,
      storage as unknown as StoragePort,
      {} as RuntimeCapabilityTracker,
    );
  });

  it('queries only large-reply entries and returns the skew report', async () => {
    const report = await service.getScanSkewAnalysis({ connectionId: 'conn-1' });
    expect(storage.getCommandLogEntries).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'large-reply', connectionId: 'conn-1', limit: 500 }),
    );
    expect(report.offenders).toHaveLength(1);
    expect(report.offenders[0].key).toBe('recroom:todo:redo');
    expect(report.entriesAnalyzed).toBe(2);
  });

  it('honours an explicit limit and passes time filters through', async () => {
    await service.getScanSkewAnalysis({ startTime: 100, endTime: 200, limit: 50 });
    expect(storage.getCommandLogEntries).toHaveBeenCalledWith(
      expect.objectContaining({ startTime: 100, endTime: 200, limit: 50, type: 'large-reply' }),
    );
  });

  it('forces the large-reply type even when a caller passes another type', async () => {
    await service.getScanSkewAnalysis({ type: 'slow' } as never);
    expect(storage.getCommandLogEntries).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'large-reply' }),
    );
  });
});
