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
import { SidebarProvider, useSidebar } from '../components/ui/sidebar';

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
    renderHook(() => useAppKeybindings(ACTIONS, { isCloud: false, shortcutsOpen: false }), {
      wrapper: MemoryRouter,
    });

    pressThemeShortcut();

    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('flips back on a second press', () => {
    // Registered once, so a captured `resolvedTheme` would leave every press
    // after the first setting the theme it was already on.
    renderHook(() => useAppKeybindings(ACTIONS, { isCloud: false, shortcutsOpen: false }), {
      wrapper: MemoryRouter,
    });

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
      () =>
        useAppKeybindings(
          { ...ACTIONS, openConnectionSwitcher },
          { isCloud: false, shortcutsOpen: false },
        ),
      {
        wrapper: MemoryRouter,
      },
    );

    fireEvent.keyDown(document, { key: 'k', code: 'KeyK', ctrlKey: true });

    expect(openConnectionSwitcher).toHaveBeenCalledTimes(1);
  });

  it('suspends the panel and theme bindings while the cheat sheet is open', () => {
    // The sheet is aria-modal, so Mod+K opening the switcher underneath it, or
    // Ctrl+Shift+L repainting the page behind it, contradicts what it claims.
    const openConnectionSwitcher = vi.fn();
    const toggleSidebar = vi.fn();
    const toggleCli = vi.fn();
    renderHook(
      () =>
        useAppKeybindings(
          { ...ACTIONS, openConnectionSwitcher, toggleSidebar, toggleCli },
          { isCloud: false, shortcutsOpen: true },
        ),
      { wrapper: MemoryRouter },
    );

    fireEvent.keyDown(document, { key: 'k', code: 'KeyK', ctrlKey: true });
    fireEvent.keyDown(document, { key: 'b', code: 'KeyB', ctrlKey: true });
    fireEvent.keyDown(document, { key: '`', code: 'Backquote', ctrlKey: true });
    pressThemeShortcut();

    expect(openConnectionSwitcher).not.toHaveBeenCalled();
    expect(toggleSidebar).not.toHaveBeenCalled();
    expect(toggleCli).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('leaves the navigation chords live while the cheat sheet is open', () => {
    // Deliberate: the sheet closes itself on a route change, so listing a chord
    // the user then cannot press would be the wrong half to suspend.
    render(
      <MemoryRouter initialEntries={['/']}>
        <Bound shortcutsOpen />
        <Routes>
          <Route path="*" element={<Path />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.keyDown(document, { key: 'g', code: 'KeyG' });
    fireEvent.keyDown(document, { key: 's', code: 'KeyS' });

    expect(screen.getByTestId('path')).toHaveTextContent('/slowlog');
  });

  it('toggles the sidebar exactly once on Mod+B', () => {
    // SidebarProvider used to ship its own window listener for Cmd/Ctrl+B, so
    // one press ran both handlers and the sidebar ended where it started.
    render(
      <MemoryRouter>
        <SidebarProvider>
          <SidebarBound />
        </SidebarProvider>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('sidebar-state')).toHaveTextContent('expanded');

    fireEvent.keyDown(document, { key: 'b', code: 'KeyB', ctrlKey: true });

    expect(screen.getByTestId('sidebar-state')).toHaveTextContent('collapsed');
  });

  it('suspends the sidebar shortcut too while the cheat sheet is open', () => {
    // SidebarProvider shipped its own window listener for Cmd/Ctrl+B, outside
    // the registry — disabling our binding left that one toggling the sidebar
    // underneath the modal.
    render(
      <MemoryRouter>
        <SidebarProvider>
          <SidebarBound shortcutsOpen />
        </SidebarProvider>
      </MemoryRouter>,
    );

    fireEvent.keyDown(document, { key: 'b', code: 'KeyB', ctrlKey: true });

    expect(screen.getByTestId('sidebar-state')).toHaveTextContent('expanded');
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

function Bound({ shortcutsOpen = false }: { shortcutsOpen?: boolean }) {
  useAppKeybindings(ACTIONS, { isCloud: false, shortcutsOpen });
  return null;
}

function SidebarBound({ shortcutsOpen = false }: { shortcutsOpen?: boolean }) {
  const { state, toggleSidebar } = useSidebar();
  useAppKeybindings({ ...ACTIONS, toggleSidebar }, { isCloud: false, shortcutsOpen });
  return <span data-testid="sidebar-state">{state}</span>;
}

function Path() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}
