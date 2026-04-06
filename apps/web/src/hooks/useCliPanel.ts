import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'betterdb-cli-open';

export function useCliPanel() {
  const [isOpen, setIsOpen] = useState(() => {
    return sessionStorage.getItem(STORAGE_KEY) === 'true';
  });

  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY, String(isOpen));
  }, [isOpen]);

  // Global Ctrl+` shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  return { isOpen, toggle, open, close };
}
