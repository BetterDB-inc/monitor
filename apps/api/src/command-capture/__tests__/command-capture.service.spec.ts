import { CommandCaptureService } from '../command-capture.service';
import { MemoryAdapter } from '../../storage/adapters/memory.adapter';

describe('CommandCaptureService', () => {
  let service: CommandCaptureService;
  let storage: MemoryAdapter;

  beforeEach(async () => {
    storage = new MemoryAdapter();
    await storage.initialize();
    service = new CommandCaptureService(storage as any);
  });

  describe('startSession', () => {
    it('creates an active session', async () => {
      const session = await service.startSession({
        connectionId: 'conn-1',
        durationMs: 60_000,
        createdBy: 'test-user',
      });

      expect(session.id).toBeDefined();
      expect(session.connectionId).toBe('conn-1');
      expect(session.status).toBe('active');
      expect(session.durationMs).toBe(60_000);
      expect(session.expiresAt).toBeGreaterThan(Date.now() - 1000);
      expect(session.commandCount).toBe(0);
      expect(session.createdBy).toBe('test-user');
    });

    it('rejects a second active session for the same instance', async () => {
      await service.startSession({ connectionId: 'conn-1', durationMs: 60_000 });
      await expect(
        service.startSession({ connectionId: 'conn-1', durationMs: 60_000 }),
      ).rejects.toThrow(/already exists/);
    });

    it('allows a new session after the first expires', async () => {
      const first = await service.startSession({ connectionId: 'conn-1', durationMs: 1 });
      // Manually expire it
      await storage.updateCommandCaptureSession(first.id, {
        status: 'expired',
      });
      const second = await service.startSession({ connectionId: 'conn-1', durationMs: 60_000 });
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe('active');
    });
  });

  describe('stopSession', () => {
    it('marks the active session as stopped', async () => {
      await service.startSession({ connectionId: 'conn-1', durationMs: 60_000 });
      const stopped = await service.stopSession('conn-1');
      expect(stopped).not.toBeNull();
      expect(stopped!.status).toBe('stopped');
      expect(stopped!.stoppedAt).toBeDefined();
    });

    it('returns null when no active session exists', async () => {
      const result = await service.stopSession('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getActiveWindow (poll)', () => {
    it('returns active with caps for an active session', async () => {
      await service.startSession({
        connectionId: 'conn-1',
        durationMs: 60_000,
        commandCap: 5000,
      });

      const window = await service.getActiveWindow('conn-1');
      expect(window.active).toBe(true);
      expect(window.maxCommands).toBe(5000);
      expect(window.maxDurationMs).toBeGreaterThan(0);
      expect(window.maxDurationMs).toBeLessThanOrEqual(60_000);
    });

    it('returns inactive when no session exists', async () => {
      const window = await service.getActiveWindow('conn-1');
      expect(window.active).toBe(false);
    });

    it('returns inactive for expired session', async () => {
      const session = await service.startSession({
        connectionId: 'conn-1',
        durationMs: 1,
      });
      // Force expiry by patching expiresAt
      await storage.updateCommandCaptureSession(session.id, {
        status: 'active', // still "active" in DB but past expiresAt
      });
      // Override expiresAt in storage
      const stored = await storage.getCommandCaptureSession(session.id);
      if (stored) {
        (stored as any).expiresAt = Date.now() - 1000;
      }

      const window = await service.getActiveWindow('conn-1');
      expect(window.active).toBe(false);
    });
  });

  describe('getActiveSessions (user-facing status read)', () => {
    it('returns the active session', async () => {
      await service.startSession({ connectionId: 'conn-1', durationMs: 60_000 });
      const sessions = await service.getActiveSessions('conn-1');
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe('active');
      expect(sessions[0].connectionId).toBe('conn-1');
    });

    it('returns empty when no active session', async () => {
      const sessions = await service.getActiveSessions('conn-1');
      expect(sessions).toEqual([]);
    });
  });

  describe('ingestBatch', () => {
    it('persists commands for an active session', async () => {
      await service.startSession({ connectionId: 'conn-1', durationMs: 60_000 });

      const result = await service.ingestBatch('conn-1', {
        connectionId: 'wrapper-uuid',
        commands: [
          { connectionId: 'wrapper-uuid', name: 'SET', args: ['key1', 'val1'], ts: Date.now() },
          { connectionId: 'wrapper-uuid', name: 'GET', args: ['key1'], ts: Date.now() },
        ],
      });

      expect(result.accepted).toBe(2);
      expect(result.dropped).toBe(false);
    });

    it('discards commands when no active session exists', async () => {
      const result = await service.ingestBatch('conn-1', {
        connectionId: 'wrapper-uuid',
        commands: [
          { connectionId: 'wrapper-uuid', name: 'SET', args: ['x', 'y'], ts: Date.now() },
        ],
      });

      expect(result.accepted).toBe(0);
      expect(result.dropped).toBe(true);
    });
  });

  describe('pruneOldRecords', () => {
    it('removes records older than retention', async () => {
      await service.startSession({ connectionId: 'conn-1', durationMs: 60_000 });

      // Insert old records directly into storage
      const oldTs = Date.now() - 4 * 24 * 60 * 60 * 1000; // 4 days ago
      await storage.saveCommandCaptureRecords([
        { sessionId: 'old-session', connectionId: 'conn-1', wrapperConnectionId: 'w1', name: 'SET', args: ['a', 'b'], ts: oldTs },
        { sessionId: 'old-session', connectionId: 'conn-1', wrapperConnectionId: 'w1', name: 'GET', args: ['a'], ts: Date.now() },
      ]);

      const result = await service.pruneOldRecords(3);
      expect(result.records).toBe(1); // only the old one
    });
  });
});
