import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTheme } from './useTheme';

// Mock matchMedia
function createMatchMediaMock(matches: boolean) {
  const listeners: Array<(e: MediaQueryListEvent) => void> = [];
  return {
    matches,
    addEventListener: vi.fn((_event: string, handler: (e: MediaQueryListEvent) => void) => {
      listeners.push(handler);
    }),
    removeEventListener: vi.fn((_event: string, handler: (e: MediaQueryListEvent) => void) => {
      const idx = listeners.indexOf(handler);
      if (idx >= 0) listeners.splice(idx, 1);
    }),
    // Helper to simulate a system preference change
    _triggerChange(newMatches: boolean) {
      listeners.forEach(fn => fn({ matches: newMatches } as MediaQueryListEvent));
    },
    _listeners: listeners,
  };
}

// Mock localStorage (happy-dom's implementation is incomplete)
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
    get length() { return Object.keys(store).length; },
    key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
    _store: store,
    _reset() { store = {}; },
  };
})();

describe('useTheme', () => {
  let matchMediaMock: ReturnType<typeof createMatchMediaMock>;

  beforeEach(() => {
    // Setup localStorage mock
    vi.stubGlobal('localStorage', localStorageMock);
    localStorageMock._reset();

    // Clear the dark class
    document.documentElement.classList.remove('dark');

    // Setup matchMedia mock (default: light system preference)
    matchMediaMock = createMatchMediaMock(false);
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(matchMediaMock));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to system preference when no localStorage value', () => {
    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe('system');
    expect(result.current.resolvedTheme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('defaults to dark when system prefers dark', () => {
    matchMediaMock = createMatchMediaMock(true);
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(matchMediaMock));

    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe('system');
    expect(result.current.resolvedTheme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('applies dark class when theme is set to dark', () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.setTheme('dark');
    });

    expect(result.current.theme).toBe('dark');
    expect(result.current.resolvedTheme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('removes dark class when theme is set to light', () => {
    // Start with dark
    localStorageMock.setItem('theme', 'dark');
    const { result } = renderHook(() => useTheme());

    expect(document.documentElement.classList.contains('dark')).toBe(true);

    act(() => {
      result.current.setTheme('light');
    });

    expect(result.current.theme).toBe('light');
    expect(result.current.resolvedTheme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('persists theme to localStorage on change', () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.setTheme('dark');
    });
    expect(localStorage.getItem('theme')).toBe('dark');

    act(() => {
      result.current.setTheme('light');
    });
    expect(localStorage.getItem('theme')).toBe('light');

    act(() => {
      result.current.setTheme('system');
    });
    expect(localStorage.getItem('theme')).toBe('system');
  });

  it('reads stored preference from localStorage on mount', () => {
    localStorageMock.setItem('theme', 'dark');

    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe('dark');
    expect(result.current.resolvedTheme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('responds to system preference change when in system mode', () => {
    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe('system');
    expect(result.current.resolvedTheme).toBe('light');

    // Simulate system dark mode change
    act(() => {
      matchMediaMock._triggerChange(true);
    });

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    // resolvedTheme must also update so components re-render
    expect(result.current.resolvedTheme).toBe('dark');
  });

  it('ignores system preference changes when theme is explicitly set', () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.setTheme('light');
    });

    // Simulate system dark mode change — should be ignored
    act(() => {
      matchMediaMock._triggerChange(true);
    });

    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('cleans up matchMedia listener on unmount', () => {
    const { unmount } = renderHook(() => useTheme());

    expect(matchMediaMock.addEventListener).toHaveBeenCalled();

    unmount();

    expect(matchMediaMock.removeEventListener).toHaveBeenCalled();
  });
});
