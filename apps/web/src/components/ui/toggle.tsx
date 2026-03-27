import { cn } from '../../lib/utils';

interface ToggleProps {
  checked: boolean;
  onChange: () => void;
  className?: string;
}

export function Toggle({ checked, onChange, className }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={cn(
        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
        checked ? 'bg-blue-600' : 'bg-gray-300',
        className,
      )}
    >
      <span
        className={cn(
          'inline-block shrink-0 h-4 w-4 min-w-4 transform rounded-full bg-white transition-transform',
          checked ? 'translate-x-6' : 'translate-x-1',
        )}
      />
    </button>
  );
}
