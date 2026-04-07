import { Link } from 'react-router-dom';
import { useLicense } from '../../hooks/useLicense';
import { Feature } from '@betterdb/shared';

interface NavItemProps {
  children: React.ReactNode;
  active: boolean;
  to: string;
  requiredFeature?: Feature;
}

export function NavItem({ children, active, to, requiredFeature }: NavItemProps) {
  const { hasFeature } = useLicense();

  const isLocked = requiredFeature && !hasFeature(requiredFeature);
  const tooltipText = isLocked
    ? 'Register free to unlock this feature'
    : undefined;

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

  return (
    <Link
      to={to}
      className={`block w-full rounded-md px-3 py-2 text-sm transition-colors ${active
        ? 'bg-primary text-primary-foreground'
        : 'hover:bg-muted'
        }`}
    >
      {children}
    </Link>
  );
}
