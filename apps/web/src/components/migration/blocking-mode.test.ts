import { describe, expect, it } from 'vitest';
import type { Incompatibility } from '@betterdb/shared';
import {
  FORCE_REASON_MIN_LENGTH,
  blockingCountForMode,
  buildStartExecutionBody,
  isForceReasonValid,
  modesWithoutBlockers,
} from './blocking-mode';

const unscoped: Incompatibility = { severity: 'blocking', category: 'hfe', title: 'HFE', detail: 'd' };
const shakeOnly: Incompatibility = {
  severity: 'blocking', category: 'capacity', title: 'cap (RedisShake modes)', detail: 'd',
  modes: ['redis_shake', 'redis_shake_sync'],
};
const warning: Incompatibility = { severity: 'warning', category: 'capacity', title: 'w', detail: 'd' };

describe('blockingCountForMode', () => {
  it('counts a RedisShake-only blocker for RedisShake but not command mode', () => {
    const result = { incompatibilities: [shakeOnly, warning], blockingCount: 1 };
    expect(blockingCountForMode(result, 'command')).toBe(0);
    expect(blockingCountForMode(result, 'redis_shake')).toBe(1);
  });
  it('counts unscoped blockers in every mode and all blockers without a mode', () => {
    const result = { incompatibilities: [unscoped, shakeOnly] };
    expect(blockingCountForMode(result, 'command')).toBe(1);
    expect(blockingCountForMode(result)).toBe(2);
  });
  it('falls back to blockingCount when there are no incompatibilities', () => {
    expect(blockingCountForMode({ blockingCount: 3 }, 'command')).toBe(3);
    expect(blockingCountForMode({})).toBe(0);
  });
});

describe('modesWithoutBlockers', () => {
  it('names the modes a scoped blocker leaves free', () => {
    expect(modesWithoutBlockers([shakeOnly])).toEqual(['command']);
  });
  it('is empty when every blocker is unscoped or there are none', () => {
    expect(modesWithoutBlockers([unscoped])).toEqual([]);
    expect(modesWithoutBlockers([warning])).toEqual([]);
    expect(modesWithoutBlockers(undefined)).toEqual([]);
  });
});

describe('buildStartExecutionBody', () => {
  const base = { sourceConnectionId: 's', targetConnectionId: 't', mode: 'command' as const };
  it('sends no force fields when the selected mode has no blockers', () => {
    expect(buildStartExecutionBody({ ...base, blockers: [], forceReason: 'ignored' })).toEqual(base);
  });
  it('sends force and the trimmed reason when the mode has blockers', () => {
    expect(buildStartExecutionBody({ ...base, blockers: [unscoped], forceReason: '  checked manually  ' }))
      .toEqual({ ...base, force: true, forceReason: 'checked manually' });
  });
  it('passes other request fields through unchanged', () => {
    expect(buildStartExecutionBody({ ...base, blockers: [], extra: { redisShakeOptions: { tryDiskless: true } } }))
      .toEqual({ ...base, redisShakeOptions: { tryDiskless: true } });
  });
});

describe('isForceReasonValid', () => {
  it('rejects empty and whitespace-only reasons', () => {
    expect(isForceReasonValid(undefined)).toBe(false);
    expect(isForceReasonValid('   ')).toBe(false);
  });
  it('accepts a reason that meets the server minimum', () => {
    expect(isForceReasonValid('x'.repeat(FORCE_REASON_MIN_LENGTH))).toBe(true);
  });
});
