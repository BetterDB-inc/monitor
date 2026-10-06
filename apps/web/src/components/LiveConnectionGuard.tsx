import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Unplug } from 'lucide-react';
import { useConnection } from '../hooks/useConnection';
import { isExternalConnection } from '../utils/connectionType';
import { EXTERNAL_UNSUPPORTED_MESSAGE } from '../api/client';
import { Button } from './ui/button';
import { EmptyState } from './ui/empty-state';

export function LiveConnectionGuard({ children }: { children: ReactNode }) {
  const { currentConnection } = useConnection();
  if (!isExternalConnection(currentConnection)) {
    return <>{children}</>;
  }
  return (
    <EmptyState
      className="flex flex-1 flex-col items-center justify-center"
      icon={Unplug}
      title="Live connection required"
      description={EXTERNAL_UNSUPPORTED_MESSAGE}
      action={
        <Button asChild variant="outline" size="sm">
          <Link to="/">Go to Dashboard</Link>
        </Button>
      }
    />
  );
}
