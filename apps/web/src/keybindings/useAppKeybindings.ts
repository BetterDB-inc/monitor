import { useNavigate } from 'react-router-dom';
import { useHotkeys, useHotkeySequences } from '@tanstack/react-hotkeys';
import { NAV_CHORDS, labelFor, sequenceFor } from './bindings';

export interface AppKeybindingActions {
  toggleCli: () => void;
  toggleSidebar: () => void;
  openConnectionSwitcher: () => void;
  showShortcuts: () => void;
}

/**
 * Registers every global binding in one place.
 *
 * Input guarding is not hand-rolled: `ignoreInputs` defaults per hotkey — true
 * for bare keys like the `g` leader and `?`, false for Mod combos — so typing
 * in the CLI cannot navigate away, while Mod+K still opens the switcher from
 * inside a text field.
 */
export function useAppKeybindings(actions: AppKeybindingActions): void {
  const navigate = useNavigate();

  useHotkeySequences(
    NAV_CHORDS.map((chord) => {
      return {
        sequence: sequenceFor(chord),
        callback: () => navigate(chord.path),
        options: {
          meta: { name: chord.name, group: 'Navigation', label: labelFor(chord) },
        },
      };
    }),
  );

  useHotkeys([
    {
      hotkey: 'Mod+K',
      callback: actions.openConnectionSwitcher,
      options: { meta: { name: 'Switch connection', group: 'Panels', label: 'Mod+K' } },
    },
    {
      // Was Ctrl-only in useCliPanel, so it never worked with Cmd on macOS.
      // `Mod` resolves per platform, which is the fix rather than a special case.
      hotkey: 'Mod+`',
      callback: actions.toggleCli,
      options: { meta: { name: 'Toggle CLI', group: 'Panels', label: 'Mod+`' } },
    },
    {
      hotkey: 'Mod+B',
      callback: actions.toggleSidebar,
      options: { meta: { name: 'Toggle sidebar', group: 'Panels', label: 'Mod+B' } },
    },
    {
      // Object form: '?' is Shift+/ and not in the type-safe Hotkey union.
      hotkey: { key: '?' },
      callback: actions.showShortcuts,
      options: { meta: { name: 'Keyboard shortcuts', group: 'Help', label: '?' } },
    },
  ]);
}
