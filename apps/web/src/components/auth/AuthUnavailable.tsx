import { ReactElement } from 'react';
import { Button } from '@/components/ui/button';

export function AuthUnavailable({ onRetry }: { onRetry: () => void }): ReactElement {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <p className="text-sm text-muted-foreground">Cannot reach the server</p>
      <Button variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
