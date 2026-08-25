import { useNavigate } from 'react-router-dom';
import { useLicense } from '../hooks/useLicense';
import { useCapabilities } from '../hooks/useCapabilities';
import { useTheme } from '../hooks/useTheme';
import { useIsDemo } from '../contexts/DemoContext';
import { useHotkeys, useHotkeySequences } from '@tanstack/react-hotkeys';
import { availableChords, sequenceFor } from './bindings';

export interface AppKeybindingActions {
  toggleCli: () => void;
  toggleSidebar: () => void;
  openConnectionSwitcher: () => void;
  showShortcuts: () => void;
}

export interface AppKeybindingEnvironment {
  /** Cloud and self-hosted expose different routes; chords follow the sidebar. */
  isCloud: boolean;
}

/**
 * Registers every global binding in one place.
 *
 * Input guarding is not hand-rolled: `ignoreInputs` defaults per hotkey — true
 * for bare keys like the `g` leader and `?`, false for Mod combos — so typing
 * in the CLI cannot navigate away, while Mod+K still opens the switcher from
 * inside a text field.
 */
export function useAppKeybindings(
  actions: AppKeybindingActions,
  environment: AppKeybindingEnvironment,
): void {
  const navigate = useNavigate();
  const { hasFeature } = useLicense();
  const { hasVectorSearch } = useCapabilities();
  const isDemo = useIsDemo();
  const { toggleTheme } = useTheme();

  useHotkeySequences(
    availableChords({ hasFeature, hasVectorSearch, isDemo, isCloud: environment.isCloud }).map(
      (chord) => {
        return {
          sequence: sequenceFor(chord),
          callback: () => navigate(chord.path),
          options: {
            meta: { name: chord.name, group: 'Navigation' },
          },
        };
      },
    ),
  );

  useHotkeys([
    {
      hotkey: 'Mod+K',
      callback: actions.openConnectionSwitcher,
      options: { meta: { name: 'Switch connection', group: 'Panels' } },
    },
    {
      // Ctrl on every platform, deliberately NOT Mod. Cmd+` is a macOS system
      // shortcut (cycle windows within an app), so Mod would collide there —
      // which is why terminals bind Ctrl+` everywhere, macOS included. The
      // original Ctrl-only binding was right; treating it as a bug was my error.
      hotkey: 'Control+`',
      callback: actions.toggleCli,
      options: { meta: { name: 'Toggle CLI', group: 'Panels' } },
    },
    {
      hotkey: 'Mod+B',
      callback: actions.toggleSidebar,
      options: { meta: { name: 'Toggle sidebar', group: 'Panels' } },
    },
    {
      // Object form: '?' is not in the type-safe Hotkey union. `shift` must be
      // set explicitly — it defaults to false, so `{ key: '?' }` registered a
      // '?' pressed *without* Shift, which no keyboard can produce.
      hotkey: { key: '?', shift: true },
      callback: actions.showShortcuts,
      options: { meta: { name: 'Keyboard shortcuts', group: 'Help' } },
    },
    {
      // Ctrl on every platform, deliberately NOT Mod: Notion binds Ctrl+Shift+L
      // on macOS too, so Cmd would be the odd one out. Registered here rather
      // than inside ModeToggle, which the mobile sidebar unmounts along with
      // the binding.
      hotkey: 'Control+Shift+L',
      callback: toggleTheme,
      options: { meta: { name: 'Toggle theme', group: 'View' } },
    },
  ]);
}
