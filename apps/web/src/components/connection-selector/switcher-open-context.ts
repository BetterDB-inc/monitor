import { createContext } from 'react';

export interface ConnectionSwitcherOpenState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

/**
 * Lets a keyboard shortcut open the switcher from outside the sidebar.
 *
 * The state lives above the sidebar rather than inside `ConnectionSwitcher`
 * because on mobile the sidebar is a Sheet, and Radix unmounts its content when
 * closed — an event dispatched at the switcher would arrive before anything was
 * listening. Held here, the request survives until the switcher mounts.
 *
 * Null when no provider is present, in which case the switcher keeps its own
 * state and behaves exactly as it did before.
 */
export const ConnectionSwitcherOpenContext = createContext<ConnectionSwitcherOpenState | null>(
  null,
);
