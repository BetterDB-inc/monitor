import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Mock the shadcn Switch (its @/ imports don't resolve in vitest)
vi.mock('./ui/switch', () => ({
  Switch: ({ checked, onCheckedChange, ...props }: { checked?: boolean; onCheckedChange?: (v: boolean) => void; 'aria-label'?: string }) => (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={props['aria-label']}
      onClick={() => onCheckedChange?.(!checked)}
      data-testid="theme-switch"
    />
  ),
}));

import { ModeToggle } from './ModeToggle';

// Mock matchMedia
function createMatchMediaMock(matches: boolean) {
  return {
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
    get length() { return Object.keys(store).length; },
    key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
    _reset() { store = {}; },
  };
})();

describe('ModeToggle', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', localStorageMock);
    localStorageMock._reset();
    document.documentElement.classList.remove('dark');
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(createMatchMediaMock(false)));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders with light mode label by default', () => {
    render(<ModeToggle />);

    expect(screen.getByText('Light mode')).toBeInTheDocument();
    expect(screen.getByRole('switch')).not.toBeChecked();
  });

  it('renders with dark mode label when theme is dark', () => {
    localStorageMock.setItem('theme', 'dark');

    render(<ModeToggle />);

    expect(screen.getByText('Dark mode')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeChecked();
  });

  it('toggles from light to dark when switch is clicked', () => {
    render(<ModeToggle />);

    const toggle = screen.getByRole('switch');
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    expect(screen.getByText('Dark mode')).toBeInTheDocument();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('theme')).toBe('dark');
  });

  it('toggles from dark to light when switch is clicked', () => {
    localStorageMock.setItem('theme', 'dark');

    render(<ModeToggle />);

    const toggle = screen.getByRole('switch');
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);

    expect(screen.getByText('Light mode')).toBeInTheDocument();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('theme')).toBe('light');
  });

  it('has accessible label for screen readers', () => {
    render(<ModeToggle />);

    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-label', 'Toggle dark mode');
  });
});
