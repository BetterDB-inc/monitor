import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useAppKeybindings } from './useAppKeybindings';

vi.mock('../components/ui/switch', () => ({
  Switch: ({ checked, 'aria-label': label }: { checked?: boolean; 'aria-label'?: string }) => (
    <button role="switch" aria-checked={checked} aria-label={label} />
  ),
}));

import { ModeToggle } from '../components/ModeToggle';

const noop = () => {};

const ACTIONS = {
  toggleCli: noop,
  toggleSidebar: noop,
  openConnectionSwitcher: noop,
  showShortcuts: noop,
};

function pressThemeShortcut(): void {
  // The manager listens on document, so dispatch there rather than on a node.
  fireEvent.keyDown(document, { key: 'L', code: 'KeyL', ctrlKey: true, shiftKey: true });
}

describe('useAppKeybindings', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    document.documentElement.classList.remove('dark');
  });

  it('toggles the theme with no ModeToggle mounted', () => {
    // The binding used to live inside ModeToggle, which the mobile sidebar
    // renders in a Sheet — closed, the switch and its shortcut both stopped
    // existing. Registered globally it survives that unmount.
    renderHook(() => useAppKeybindings(ACTIONS, { isCloud: false }), { wrapper: MemoryRouter });

    pressThemeShortcut();

    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('flips back on a second press', () => {
    // Registered once, so a captured `resolvedTheme` would leave every press
    // after the first setting the theme it was already on.
    renderHook(() => useAppKeybindings(ACTIONS, { isCloud: false }), { wrapper: MemoryRouter });

    pressThemeShortcut();
    pressThemeShortcut();

    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('leaves a mounted switch showing the theme it just set', () => {
    render(
      <MemoryRouter>
        <Bound />
        <ModeToggle />
      </MemoryRouter>,
    );

    pressThemeShortcut();

    expect(screen.getByRole('switch')).toBeChecked();
  });

  it('opens the connection switcher on Mod+K', () => {
    const openConnectionSwitcher = vi.fn();
    renderHook(
      () => useAppKeybindings({ ...ACTIONS, openConnectionSwitcher }, { isCloud: false }),
      {
        wrapper: MemoryRouter,
      },
    );

    fireEvent.keyDown(document, { key: 'k', code: 'KeyK', ctrlKey: true });

    expect(openConnectionSwitcher).toHaveBeenCalledTimes(1);
  });

  it('navigates on a leader chord', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Bound />
        <Routes>
          <Route path="*" element={<Path />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.keyDown(document, { key: 'g', code: 'KeyG' });
    fireEvent.keyDown(document, { key: 's', code: 'KeyS' });

    expect(screen.getByTestId('path')).toHaveTextContent('/slowlog');
  });
});

function Bound() {
  useAppKeybindings(ACTIONS, { isCloud: false });
  return null;
}

function Path() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}
