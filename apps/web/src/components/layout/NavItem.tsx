import { Link } from 'react-router-dom';
import { useLicense } from '../../hooks/useLicense';
import { Feature } from '@betterdb/shared';
import { chordForPath, labelFor } from '@/keybindings/bindings';

const DEMO_TOOLTIP = 'Not available in demo mode';

interface NavItemProps {
  children: React.ReactNode;
  active: boolean;
  to: string;
  requiredFeature?: Feature;
  demoLocked?: boolean;
}

export function NavItem({ children, active, to, requiredFeature, demoLocked }: NavItemProps) {
  const { hasFeature } = useLicense();

  if (demoLocked) {
    return (
      <span
        data-tooltip-id="license-tooltip"
        data-tooltip-content={DEMO_TOOLTIP}
        className="block w-full rounded-md px-3 py-2 text-sm opacity-40 cursor-not-allowed select-none"
      >
        {children}
      </span>
    );
  }

  const isLocked = requiredFeature && !hasFeature(requiredFeature);
  const tooltipText = isLocked ? 'Register free to unlock this feature' : undefined;

  if (isLocked) {
    return (
      <Link
        to="/settings"
        data-tooltip-id="license-tooltip"
        data-tooltip-content={tooltipText}
        className="block w-full rounded-md px-3 py-2 text-sm opacity-50 hover:opacity-75 transition-opacity flex items-center justify-between"
      >
        <span>{children}</span>
        <span className="text-[10px] px-1.5 py-0.5 bg-green-600 text-white rounded font-medium">
          Free
        </span>
      </Link>
    );
  }

  // Looked up by path rather than passed in, so the hint and the binding that
  // actually fires come from the same row of the chord table.
  const chord = chordForPath(to);

  return (
    <Link
      to={to}
      className={`group/navitem flex w-full items-center justify-between gap-2 rounded-md ps-3 pe-2 py-2 text-sm transition-colors ${
        active ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
      }`}
    >
      <span className="min-w-0 truncate">{children}</span>
      {chord !== undefined && (
        <kbd className="shrink-0 border-accent-foreground border  px-1 font-mono font-bold text-xs opacity-0 transition-opacity duration-300 ease-out group-hover/navitem:opacity-40 group-focus-visible/navitem:opacity-60">
          {labelFor(chord)}
        </kbd>
      )}
    </Link>
  );
}
