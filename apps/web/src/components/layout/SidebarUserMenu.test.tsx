import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SidebarUserMenu } from './SidebarUserMenu';

const { authState } = vi.hoisted(() => {
  return {
    authState: {
      user: null as null | { userId: string; email: string; role: string; isOwner: boolean },
      mode: 'self-hosted' as 'self-hosted' | 'cloud' | 'disabled',
      signOut: vi.fn(),
    },
  };
});

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: authState.user,
    mode: authState.mode,
    signOut: authState.signOut,
  }),
}));

function openMenu(name: string | RegExp): void {
  fireEvent.keyDown(screen.getByRole('button', { name }), { key: 'Enter' });
}

const originalLocation = window.location;

describe('SidebarUserMenu', () => {
  afterEach(() => {
    Object.defineProperty(window, 'location', { value: originalLocation, configurable: true });
  });

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    authState.signOut.mockReset();
    authState.signOut.mockResolvedValue(undefined);
    authState.user = { userId: 'u2', email: 'member@example.com', role: 'member', isOwner: false };
    authState.mode = 'self-hosted';
  });

  it('shows the signed-in account and signs out from the menu', () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, assign },
      configurable: true,
    });
    render(<SidebarUserMenu onShortcutsClick={vi.fn()} />);

    expect(screen.getByText('member@example.com')).toBeInTheDocument();
    openMenu(/Account menu for member@example.com/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    expect(authState.signOut).toHaveBeenCalledTimes(1);
  });

  it('toggles dark mode without closing the menu', () => {
    render(<SidebarUserMenu onShortcutsClick={vi.fn()} />);

    openMenu(/Account menu/);
    const toggle = screen.getByRole('menuitemcheckbox', { name: 'Dark mode' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(screen.getByRole('menuitemcheckbox', { name: 'Dark mode' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('opens the keyboard shortcuts overlay', () => {
    const onShortcutsClick = vi.fn();
    render(<SidebarUserMenu onShortcutsClick={onShortcutsClick} />);

    openMenu(/Account menu/);
    fireEvent.click(screen.getByRole('menuitem', { name: /Keyboard shortcuts/ }));

    expect(onShortcutsClick).toHaveBeenCalledTimes(1);
  });

  it('offers preferences without an account outside self-hosted mode', () => {
    authState.mode = 'cloud';
    render(<SidebarUserMenu onShortcutsClick={vi.fn()} />);

    openMenu('Preferences menu');

    expect(screen.getByRole('menuitemcheckbox', { name: 'Dark mode' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Sign out' })).not.toBeInTheDocument();
  });
});
