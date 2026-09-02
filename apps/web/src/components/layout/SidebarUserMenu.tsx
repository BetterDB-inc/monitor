import { ReactElement } from 'react';
import { useAuth } from '../../contexts/AuthContext';

export function SidebarUserMenu(): ReactElement | null {
  const { user, mode, signOut } = useAuth();
  if (mode !== 'self-hosted' || user === null) {
    return null;
  }
  return (
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
  );
}
