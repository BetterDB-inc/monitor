import type { ReactNode } from 'react';
import { Unplug } from 'lucide-react';
import { ExternalConnectionUnsupportedError, EXTERNAL_UNSUPPORTED_MESSAGE } from '../api/client';
import { EmptyState } from './ui/empty-state';

export function findExternalUnsupportedError(
  ...errors: Array<Error | null | undefined>
): ExternalConnectionUnsupportedError | null {
  const match = errors.find((error) => error instanceof ExternalConnectionUnsupportedError);
  return match instanceof ExternalConnectionUnsupportedError ? match : null;
}

export function QueryErrorState({
  error,
  fallback = null,
}: {
  error: Error | null | undefined;
  fallback?: ReactNode;
}) {
  if (error instanceof ExternalConnectionUnsupportedError) {
    return (
      <EmptyState
        variant="inline"
        icon={Unplug}
        title="Live connection required"
        description={EXTERNAL_UNSUPPORTED_MESSAGE}
      />
    );
  }
  return <>{fallback}</>;
}
