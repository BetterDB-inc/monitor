import { describe, expect, it } from 'vitest';
import type { Incompatibility } from '@betterdb/shared';
import { blockingCountForMode, modesWithoutBlockers } from './blocking-mode';

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
