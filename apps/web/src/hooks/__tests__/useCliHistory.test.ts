import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCliHistory } from '../useCliHistory';

describe('useCliHistory', () => {
  it('adds entries to history', () => {
    const { result } = renderHook(() => useCliHistory());

    act(() => {
      result.current.addEntry('GET foo');
    });

    expect(result.current.getHistory()).toEqual(['GET foo']);
  });

  it('does not add duplicate of the last command', () => {
    const { result } = renderHook(() => useCliHistory());

    act(() => {
      result.current.addEntry('GET foo');
    });
    act(() => {
      result.current.addEntry('GET foo');
    });

    expect(result.current.getHistory()).toEqual(['GET foo']);
  });

  it('adds non-consecutive duplicates', () => {
    const { result } = renderHook(() => useCliHistory());

    act(() => {
      result.current.addEntry('GET foo');
    });
    act(() => {
      result.current.addEntry('SET bar 1');
    });
    act(() => {
      result.current.addEntry('GET foo');
    });

    expect(result.current.getHistory()).toEqual(['GET foo', 'SET bar 1', 'GET foo']);
  });

  it('enforces MAX_HISTORY limit of 100', () => {
    const { result } = renderHook(() => useCliHistory());

    for (let i = 0; i < 101; i++) {
      act(() => {
        result.current.addEntry(`cmd-${i}`);
      });
    }

    expect(result.current.getHistory()).toHaveLength(100);
    // First entry should have been dropped
    expect(result.current.getHistory()[0]).toBe('cmd-1');
    expect(result.current.getHistory()[99]).toBe('cmd-100');
  });

  it('navigateUp returns the last command', () => {
    const { result } = renderHook(() => useCliHistory());

    act(() => {
      result.current.addEntry('PING');
    });
    act(() => {
      result.current.addEntry('INFO');
    });

    let value: string | null = null;
    act(() => {
      value = result.current.navigateUp('');
    });

    expect(value).toBe('INFO');
  });

  it('navigateUp then navigateDown returns to saved input', () => {
    const { result } = renderHook(() => useCliHistory());

    act(() => {
      result.current.addEntry('PING');
    });
    act(() => {
      result.current.addEntry('INFO');
    });

    act(() => {
      result.current.navigateUp('partial');
    });

    let value: string | null = null;
    act(() => {
      value = result.current.navigateDown();
    });

    expect(value).toBe('partial');
  });

  it('navigateUp returns null on empty history', () => {
    const { result } = renderHook(() => useCliHistory());

    let value: string | null = 'initial';
    act(() => {
      value = result.current.navigateUp('');
    });

    expect(value).toBeNull();
  });

  it('navigateDown returns null when not navigating', () => {
    const { result } = renderHook(() => useCliHistory());

    let value: string | null = 'initial';
    act(() => {
      value = result.current.navigateDown();
    });

    expect(value).toBeNull();
  });

  it('navigateUp walks back through history', () => {
    const { result } = renderHook(() => useCliHistory());

    act(() => {
      result.current.addEntry('cmd-1');
    });
    act(() => {
      result.current.addEntry('cmd-2');
    });
    act(() => {
      result.current.addEntry('cmd-3');
    });

    let value: string | null = null;
    act(() => {
      value = result.current.navigateUp('');
    });
    expect(value).toBe('cmd-3');

    act(() => {
      value = result.current.navigateUp('');
    });
    expect(value).toBe('cmd-2');

    act(() => {
      value = result.current.navigateUp('');
    });
    expect(value).toBe('cmd-1');

    // At oldest, returns null
    act(() => {
      value = result.current.navigateUp('');
    });
    expect(value).toBeNull();
  });
});
