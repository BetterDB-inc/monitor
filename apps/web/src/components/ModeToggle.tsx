import { Moon, Sun } from 'lucide-react';
import { Switch } from './ui/switch';
import { useTheme } from '../hooks/useTheme';

export function ModeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

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
