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
    border: 'border-l-red-500',
    bg: 'bg-red-50 dark:bg-red-950/20',
    title: 'text-red-800 dark:text-red-300',
    text: 'text-red-700 dark:text-red-400',
    link: 'text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300',
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
    border: 'border-l-blue-500',
    bg: 'bg-blue-50 dark:bg-blue-950/20',
    title: 'text-blue-800 dark:text-blue-300',
    text: 'text-blue-700 dark:text-blue-400',
    link: 'text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300',
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
