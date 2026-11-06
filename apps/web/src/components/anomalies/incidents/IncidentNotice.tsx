import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface IncidentNoticeProps {
  role?: 'alert' | 'status';
  title?: string;
  children: ReactNode;
}

export function IncidentNotice({ role = 'status', title, children }: IncidentNoticeProps) {
  return (
    <div
      role={role}
      className="flex gap-3 rounded-lg border border-yellow-500 bg-yellow-500/10 p-4 text-sm"
    >
      <AlertTriangle className="w-5 h-5 shrink-0 text-yellow-500" aria-hidden />
      <div className="space-y-1">
        {title && <p className="font-semibold">{title}</p>}
        <div className={title ? 'text-muted-foreground' : undefined}>{children}</div>
      </div>
    </div>
  );
}
