import { useState } from 'react';

export function useConnectionDialog(connectionId: string | undefined) {
  const [shownFor, setShownFor] = useState<string | null>(null);
  const [boundTo, setBoundTo] = useState(connectionId);

  if (boundTo !== connectionId) {
    setBoundTo(connectionId);
    setShownFor(null);
  }

  const onOpenChange = (open: boolean) => {
    setShownFor((shown) => {
      if (open) return connectionId ?? null;
      return shown === connectionId ? null : shown;
    });
  };

  return {
    open: connectionId !== undefined && boundTo === connectionId && shownFor === connectionId,
    onOpenChange,
  };
}
