import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert';

interface IncidentNoticeProps {
  role?: 'alert' | 'status';
  title?: string;
  children: ReactNode;
}

export function IncidentNotice({ role = 'status', title, children }: IncidentNoticeProps) {
  return (
    <Alert role={role} className="border-yellow-500 bg-yellow-500/10 *:[svg]:text-yellow-500">
      <AlertTriangle className="w-4 h-4" aria-hidden />
      {title && <AlertTitle>{title}</AlertTitle>}
      <AlertDescription className={title ? undefined : 'text-foreground'}>
        {children}
      </AlertDescription>
    </Alert>
  );
}
