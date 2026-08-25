import { Moon, Sun } from 'lucide-react';
import { useHotkey } from '@tanstack/react-hotkeys';
import { Switch } from './ui/switch';
import { useTheme } from '../hooks/useTheme';

export function ModeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  // Ctrl on every platform, deliberately NOT Mod: Notion binds Ctrl+Shift+L on
  // macOS too, so Cmd would be the odd one out. Registered here rather than
  // with the other bindings because useTheme keeps per-instance state —
  // toggling from elsewhere would flip the document and leave this switch
  // showing the old value. The manager is a singleton, so it still lists in
  // the cheat sheet.
  useHotkey('Control+Shift+L', () => setTheme(isDark ? 'light' : 'dark'), {
    meta: { name: 'Toggle theme', group: 'View' },
  });

  return (
    <div className="flex items-center justify-between px-3 py-1.5">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {isDark ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
        <span>{isDark ? 'Dark' : 'Light'} mode</span>
      </div>
      <Switch
        checked={isDark}
        onCheckedChange={(checked) => setTheme(checked ? 'dark' : 'light')}
        size="sm"
        aria-label="Toggle dark mode"
      />
    </div>
  );
}
