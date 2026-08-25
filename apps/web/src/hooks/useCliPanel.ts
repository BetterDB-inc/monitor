import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'betterdb-cli-open';

export function useCliPanel() {
  const [isOpen, setIsOpen] = useState(() => {
    return sessionStorage.getItem(STORAGE_KEY) === 'true';
  });

  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY, String(isOpen));
  }, [isOpen]);

  // The Ctrl+` binding lives in src/keybindings, registered alongside every
  // other shortcut so it appears in the cheat sheet and is guarded consistently.
  // Keeping a second listener here toggled twice on platforms where Mod is Ctrl.

  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  return { isOpen, toggle, open, close };
}
