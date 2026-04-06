import { useCallback, useRef } from 'react';

const MAX_HISTORY = 100;

export function useCliHistory() {
  const historyRef = useRef<string[]>([]);
  const indexRef = useRef(-1);
  const savedInputRef = useRef('');

  const addEntry = useCallback((command: string) => {
    const h = historyRef.current;
    if (h.length > 0 && h[h.length - 1] === command) return;
    h.push(command);
    if (h.length > MAX_HISTORY) h.shift();
    indexRef.current = -1;
    savedInputRef.current = '';
  }, []);

  const navigateUp = useCallback((currentInput: string): string | null => {
    const h = historyRef.current;
    if (h.length === 0) return null;
    if (indexRef.current === -1) {
      savedInputRef.current = currentInput;
      indexRef.current = h.length - 1;
    } else if (indexRef.current > 0) {
      indexRef.current--;
    } else {
      return null;
    }
    return h[indexRef.current];
  }, []);

  const navigateDown = useCallback((): string | null => {
    const h = historyRef.current;
    if (indexRef.current === -1) return null;
    if (indexRef.current < h.length - 1) {
      indexRef.current++;
      return h[indexRef.current];
    }
    indexRef.current = -1;
    return savedInputRef.current;
  }, []);

  const resetNavigation = useCallback(() => {
    indexRef.current = -1;
    savedInputRef.current = '';
  }, []);

  // Expose history as a getter for the `history` builtin command
  const getHistory = useCallback((): string[] => [...historyRef.current], []);

  return { getHistory, addEntry, navigateUp, navigateDown, resetNavigation };
}
