import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useNow } from './useNow';

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('ticks every second while enabled', () => {
    const { result } = renderHook(() => useNow());
    expect(result.current).toBe(1_000_000);

    act(() => vi.advanceTimersByTime(3000));

    expect(result.current).toBe(1_003_000);
  });

  it('stays still while disabled', () => {
    const { result } = renderHook(() => useNow(false));

    act(() => vi.advanceTimersByTime(3000));

    expect(result.current).toBe(1_000_000);
  });
});
