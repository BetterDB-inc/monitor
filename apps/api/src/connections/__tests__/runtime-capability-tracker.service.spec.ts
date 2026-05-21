import {
  CAPABILITY_TEST_COMMAND,
  RuntimeCapabilityTracker,
} from '../runtime-capability-tracker.service';

describe('RuntimeCapabilityTracker', () => {
  let tracker: RuntimeCapabilityTracker;
  const connectionId = 'test-conn';

  beforeEach(() => {
    tracker = new RuntimeCapabilityTracker();
  });

  describe('defaults', () => {
    it('returns all capabilities as available when none have been recorded', () => {
      const caps = tracker.getCapabilities(connectionId);
      expect(caps.canSlowLog).toBe(true);
      expect(caps.canClientList).toBe(true);
      expect(caps.canAclLog).toBe(true);
      expect(caps.canClusterInfo).toBe(true);
      expect(caps.canClusterSlotStats).toBe(true);
      expect(caps.canCommandLog).toBe(true);
      expect(caps.canLatency).toBe(true);
      expect(caps.canMemory).toBe(true);
    });

    it('isAvailable returns true for fresh connections', () => {
      expect(tracker.isAvailable(connectionId, 'canSlowLog')).toBe(true);
    });

    it('getDisabledReasons returns an empty object for fresh connections', () => {
      expect(tracker.getDisabledReasons(connectionId)).toEqual({});
    });
  });

  describe('recordFailure - blocked-command patterns', () => {
    it('disables the capability and returns true for "unknown command"', () => {
      const handled = tracker.recordFailure(
        connectionId,
        'canSlowLog',
        new Error("ERR unknown command 'SLOWLOG'"),
      );

      expect(handled).toBe(true);
      expect(tracker.isAvailable(connectionId, 'canSlowLog')).toBe(false);
    });

    it('disables the capability for Upstash-style "Command is not available"', () => {
      const handled = tracker.recordFailure(
        connectionId,
        'canSlowLog',
        new Error("ReplyError: ERR Command is not available: 'SLOWLOG'. See https://upstash.com/docs/redis/overall/rediscompatibility for details"),
      );

      expect(handled).toBe(true);
      expect(tracker.isAvailable(connectionId, 'canSlowLog')).toBe(false);
    });

    it('disables on NOPERM ACL errors', () => {
      const handled = tracker.recordFailure(
        connectionId,
        'canAclLog',
        new Error("NOPERM this user has no permissions to run the 'acl|log' command"),
      );

      expect(handled).toBe(true);
      expect(tracker.isAvailable(connectionId, 'canAclLog')).toBe(false);
    });

    it('disables on "unknown subcommand"', () => {
      const handled = tracker.recordFailure(
        connectionId,
        'canClusterSlotStats',
        new Error("ERR Unknown subcommand 'SLOT-STATS'"),
      );

      expect(handled).toBe(true);
      expect(tracker.isAvailable(connectionId, 'canClusterSlotStats')).toBe(false);
    });

    it('accepts string errors as well as Error instances', () => {
      const handled = tracker.recordFailure(
        connectionId,
        'canSlowLog',
        "ERR Command is not available: 'SLOWLOG'",
      );

      expect(handled).toBe(true);
      expect(tracker.isAvailable(connectionId, 'canSlowLog')).toBe(false);
    });

    it('treats "cluster support disabled" (standalone) as a definitive rejection', () => {
      const handled = tracker.recordFailure(
        connectionId,
        'canClusterSlotStats',
        new Error('ERR This instance has cluster support disabled'),
      );

      expect(handled).toBe(true);
      expect(tracker.isAvailable(connectionId, 'canClusterSlotStats')).toBe(false);
    });
  });

  describe('CAPABILITY_TEST_COMMAND', () => {
    it('covers every key of RuntimeCapabilities', () => {
      const expected = [
        'canSlowLog',
        'canCommandLog',
        'canLatency',
        'canClientList',
        'canAclLog',
        'canClusterInfo',
        'canClusterSlotStats',
        'canMemory',
      ];
      expect(Object.keys(CAPABILITY_TEST_COMMAND).sort()).toEqual(expected.sort());
    });

    it('CLUSTER SLOT-STATS probe passes ORDERBY+LIMIT so a capable server does not reject on missing args', () => {
      expect(CAPABILITY_TEST_COMMAND.canClusterSlotStats).toEqual([
        'CLUSTER',
        'SLOT-STATS',
        'ORDERBY',
        'key-count',
        'LIMIT',
        '1',
      ]);
    });

    it('canClientList uses CLIENT GETNAME (O(1)) rather than CLIENT LIST', () => {
      expect(CAPABILITY_TEST_COMMAND.canClientList).toEqual(['CLIENT', 'GETNAME']);
    });
  });

  describe('recordFailure - transient errors', () => {
    it('returns false and leaves capability enabled for connection timeouts', () => {
      const handled = tracker.recordFailure(
        connectionId,
        'canSlowLog',
        new Error('Connection timeout'),
      );

      expect(handled).toBe(false);
      expect(tracker.isAvailable(connectionId, 'canSlowLog')).toBe(true);
    });

    it('returns false and leaves capability enabled for generic network errors', () => {
      const handled = tracker.recordFailure(
        connectionId,
        'canSlowLog',
        new Error('ECONNREFUSED'),
      );

      expect(handled).toBe(false);
      expect(tracker.isAvailable(connectionId, 'canSlowLog')).toBe(true);
    });
  });

  describe('getDisabledReasons', () => {
    it('records the underlying error message and a timestamp', () => {
      const before = Date.now();
      tracker.recordFailure(
        connectionId,
        'canSlowLog',
        new Error("ERR Command is not available: 'SLOWLOG'"),
      );
      const after = Date.now();

      const reasons = tracker.getDisabledReasons(connectionId);
      expect(reasons.canSlowLog).toBeDefined();
      expect(reasons.canSlowLog?.reason).toContain('Command is not available');
      expect(reasons.canSlowLog?.disabledAt).toBeGreaterThanOrEqual(before);
      expect(reasons.canSlowLog?.disabledAt).toBeLessThanOrEqual(after);
    });

    it('does NOT record a reason for transient errors', () => {
      tracker.recordFailure(connectionId, 'canSlowLog', new Error('Connection timeout'));
      expect(tracker.getDisabledReasons(connectionId)).toEqual({});
    });
  });

  describe('resetCapability', () => {
    it('re-enables a previously disabled capability', () => {
      tracker.recordFailure(
        connectionId,
        'canSlowLog',
        new Error("ERR Command is not available: 'SLOWLOG'"),
      );
      expect(tracker.isAvailable(connectionId, 'canSlowLog')).toBe(false);

      tracker.resetCapability(connectionId, 'canSlowLog');

      expect(tracker.isAvailable(connectionId, 'canSlowLog')).toBe(true);
      expect(tracker.getDisabledReasons(connectionId)).toEqual({});
    });

    it('only re-enables the capability passed in, leaving others alone', () => {
      tracker.recordFailure(connectionId, 'canSlowLog', new Error('unknown command'));
      tracker.recordFailure(connectionId, 'canAclLog', new Error('NOPERM'));

      tracker.resetCapability(connectionId, 'canSlowLog');

      expect(tracker.isAvailable(connectionId, 'canSlowLog')).toBe(true);
      expect(tracker.isAvailable(connectionId, 'canAclLog')).toBe(false);
      expect(tracker.getDisabledReasons(connectionId).canAclLog).toBeDefined();
      expect(tracker.getDisabledReasons(connectionId).canSlowLog).toBeUndefined();
    });

    it('is safe to call for a capability that was never disabled', () => {
      expect(() => tracker.resetCapability(connectionId, 'canSlowLog')).not.toThrow();
      expect(tracker.isAvailable(connectionId, 'canSlowLog')).toBe(true);
    });
  });

  describe('removeConnection', () => {
    it('clears both capabilities and reasons for the connection', () => {
      tracker.recordFailure(connectionId, 'canSlowLog', new Error('unknown command'));
      tracker.removeConnection(connectionId);

      expect(tracker.isAvailable(connectionId, 'canSlowLog')).toBe(true);
      expect(tracker.getDisabledReasons(connectionId)).toEqual({});
    });
  });
});
