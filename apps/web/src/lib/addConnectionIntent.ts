import type { ParsedConnection } from '../utils/connectionUrl';

// The Add Connection dialog lives inside the sidebar. On mobile the sidebar is
// a Sheet whose contents are unmounted while it is closed, so a plain
// dispatchEvent fired from the empty-state buttons (which live in the main
// content, outside the sidebar) reaches no listener and the dialog never opens.
//
// We fix that by stashing the request here and dispatching an event. A mounted
// dialog handles the event immediately; a dialog that mounts moments later
// (after the sidebar is revealed on mobile) consumes the stash instead.

export const OPEN_ADD_CONNECTION_EVENT = 'betterdb:open-add-connection';

export interface OpenAddConnectionOptions {
  prefill?: Partial<ParsedConnection>;
  tab?: 'direct' | 'agent' | 'valkey' | 'otlp';
  valkeyMaxmemory?: string;
}

let pending: OpenAddConnectionOptions | null = null;

export function openAddConnection(options?: OpenAddConnectionOptions): void {
  pending = options ?? {};
  window.dispatchEvent(
    new CustomEvent(OPEN_ADD_CONNECTION_EVENT, options ? { detail: options } : undefined),
  );
}

// Returns the stashed request once and clears it, so a later remount of the
// dialog does not re-open it.
export function consumePendingAddConnection(): OpenAddConnectionOptions | null {
  const stashed = pending;
  pending = null;
  return stashed;
}
