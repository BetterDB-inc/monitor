import type { ReactNode } from 'react';
import { AlertTriangle, AlertCircle, Info } from 'lucide-react';

interface InsightCalloutProps {
  severity: 'error' | 'warning' | 'info';
  title: string;
  description: string;
  docUrl: string;
  docLabel: string;
  children?: ReactNode;
}

const styles = {
  error: {
    border: 'border-l-destructive',
    bg: 'bg-destructive/5 dark:bg-destructive/10',
    title: 'text-destructive',
    text: 'text-destructive/80',
    link: 'text-destructive hover:text-destructive/80',
    Icon: AlertCircle,
  },
  warning: {
    border: 'border-l-yellow-500',
    bg: 'bg-yellow-500/10 dark:bg-yellow-500/10',
    title: 'text-yellow-700 dark:text-yellow-400',
    text: 'text-yellow-700 dark:text-yellow-400',
    link: 'text-yellow-600 hover:text-yellow-800 dark:text-yellow-500 dark:hover:text-yellow-300',
    Icon: AlertTriangle,
  },
  info: {
    border: 'border-l-primary',
    bg: 'bg-primary/5 dark:bg-primary/10',
    title: 'text-primary',
    text: 'text-primary/80',
    link: 'text-primary hover:text-primary/80',
    Icon: Info,
  },
};

export function InsightCallout({ severity, title, description, docUrl, docLabel, children }: InsightCalloutProps) {
  const s = styles[severity];
  const { Icon } = s;

  return (
    <div className={`border-l-4 ${s.border} ${s.bg} rounded-r-md px-4 py-3`}>
      <div className="flex items-start gap-2.5">
        <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${s.title}`} />
        <div className="space-y-1 min-w-0 flex-1">
          <p className={`text-sm font-medium ${s.title}`}>{title}</p>
          <p className={`text-sm ${s.text}`}>{description}</p>
          <div className="flex items-center justify-between gap-2">
            <a
              href={docUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`inline-block text-xs font-medium ${s.link} mt-1`}
            >
              {docLabel} &rarr;
            </a>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
