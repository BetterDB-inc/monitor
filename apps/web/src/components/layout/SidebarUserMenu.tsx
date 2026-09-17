import { ReactElement } from 'react';
import { ChevronsUpDown, Keyboard, LogOut, Moon, SlidersHorizontal, Sun } from 'lucide-react';
import { formatForDisplay } from '@tanstack/hotkeys';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../hooks/useTheme';
import { Switch } from '../ui/switch';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

interface SidebarUserMenuProps {
  onShortcutsClick: () => void;
}

function signOutAndLeave(signOut: () => Promise<void>): void {
  signOut()
    .then(() => {
      window.location.assign('/login');
    })
    .catch(() => {
      window.location.assign('/login');
    });
}

export function SidebarUserMenu({ onShortcutsClick }: SidebarUserMenuProps): ReactElement {
  const { user, mode, signOut } = useAuth();
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const account = mode === 'self-hosted' ? user : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={account ? `Account menu for ${account.email}` : 'Preferences menu'}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-hidden transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted"
      >
        {account ? (
          <>
            <span
              aria-hidden="true"
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
            >
              {account.email.charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate" title={account.email}>
                {account.email}
              </span>
              <span className="block text-[10px] uppercase text-muted-foreground">
                {account.role}
              </span>
            </span>
          </>
        ) : (
          <>
            <SlidersHorizontal
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
            <span className="flex-1">Preferences</span>
          </>
        )}
        <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="w-(--radix-dropdown-menu-trigger-width)"
      >
        {account && (
          <>
            <DropdownMenuLabel className="truncate">Signed in as {account.email}</DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuCheckboxItem
          checked={isDark}
          onCheckedChange={(checked) => setTheme(checked ? 'dark' : 'light')}
          onSelect={(event) => event.preventDefault()}
        >
          {isDark ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
          <span>Dark mode</span>
          <Switch
            checked={isDark}
            size="sm"
            tabIndex={-1}
            aria-hidden="true"
            className="pointer-events-none ml-auto"
          />
        </DropdownMenuCheckboxItem>
        <DropdownMenuItem onSelect={onShortcutsClick}>
          <Keyboard aria-hidden="true" />
          <span>Keyboard shortcuts</span>
          <DropdownMenuShortcut>{formatForDisplay('shift+?')}</DropdownMenuShortcut>
        </DropdownMenuItem>
        {account && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => signOutAndLeave(signOut)}>
              <LogOut aria-hidden="true" />
              <span>Sign out</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
