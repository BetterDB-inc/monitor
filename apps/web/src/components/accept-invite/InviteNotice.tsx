import { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router-dom';

export function InviteNotice({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-8">
      <div className="w-full max-w-sm space-y-4 text-center">
        <p className="text-sm text-muted-foreground">{children}</p>
        <Link to="/login" className="text-sm text-primary underline">
          Go to sign in
        </Link>
      </div>
    </div>
  );
}
