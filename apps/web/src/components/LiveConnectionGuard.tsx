import type { ReactNode } from 'react';
import { useConnection } from '../hooks/useConnection';
import { isExternalConnection } from '../utils/connectionType';
import { EXTERNAL_UNSUPPORTED_MESSAGE } from '../api/client';

export function LiveConnectionGuard({ children }: { children: ReactNode }) {
  const { currentConnection } = useConnection();
  if (!isExternalConnection(currentConnection)) {
    return <>{children}</>;
  }
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <h2 className="mb-2 text-lg font-semibold">Live connection required</h2>
      <p className="max-w-md text-sm text-muted-foreground">{EXTERNAL_UNSUPPORTED_MESSAGE}</p>
    </div>
  );
}
