import { ReactElement } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useDemoState } from '../../contexts/DemoContext';

export function SidebarUserMenu(): ReactElement | null {
  const { user, mode, signOut } = useAuth();
  const { isDemo } = useDemoState();
  const location = useLocation();
  if (mode !== 'self-hosted' || user === null) {
    return null;
  }
  const onMcpTokensPage = location.pathname === '/account/mcp-tokens';
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between rounded-md px-3 py-2 text-sm">
        <span className="truncate" title={user.email}>
          {user.email}
          <span className="ml-2 text-[10px] uppercase text-muted-foreground">{user.role}</span>
        </span>
        <button
          type="button"
          onClick={() => {
            signOut()
              .then(() => {
                window.location.assign('/login');
              })
              .catch(() => {
                window.location.assign('/login');
              });
          }}
          className="text-muted-foreground hover:text-foreground"
        >
          Sign out
        </button>
      </div>
      {isDemo !== true && (
        <Link
          to="/account/mcp-tokens"
          className={`block w-full rounded-md px-3 py-2 text-sm transition-colors ${
            onMcpTokensPage ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
          }`}
        >
          MCP Tokens
        </Link>
      )}
    </div>
  );
}
