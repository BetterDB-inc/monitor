import { AlertTriangle, CheckCircle } from 'lucide-react';
import { Fragment, ReactNode } from 'react';

export interface DoctorCardProps {
  title: string;
  report: string | undefined;
  isLoading: boolean;
}

const WARNING_PATTERN = /(High fragmentation|latency spikes?|too slow|advices? for you|blocked|blocking|WARNING|ERROR)/gi;
const CONFIG_PATTERN = /(CONFIG SET [^\n]+)/g;

function highlightText(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    WARNING_PATTERN.lastIndex = 0;
    CONFIG_PATTERN.lastIndex = 0;

    const warningMatch = WARNING_PATTERN.exec(remaining);
    const configMatch = CONFIG_PATTERN.exec(remaining);

    const matches = [warningMatch, configMatch].filter(Boolean) as RegExpExecArray[];
    if (matches.length === 0) {
      parts.push(<Fragment key={key}>{remaining}</Fragment>);
      break;
    }

    const firstMatch = matches.reduce((a, b) => (a.index < b.index ? a : b));
    const isWarning = firstMatch === warningMatch;

    if (firstMatch.index > 0) {
      parts.push(<Fragment key={key++}>{remaining.slice(0, firstMatch.index)}</Fragment>);
    }

    if (isWarning) {
      parts.push(
        <span key={key++} className="text-red-600 dark:text-red-400 font-semibold">
          {firstMatch[0]}
        </span>
      );
    } else {
      parts.push(
        <code key={key++} className="bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 px-1 rounded">
          {firstMatch[0]}
        </code>
      );
    }

    remaining = remaining.slice(firstMatch.index + firstMatch[0].length);
  }

  return parts;
}

export function DoctorCard({ title, report, isLoading }: DoctorCardProps) {
  if (isLoading) {
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-4 animate-pulse">
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 bg-gray-300 dark:bg-gray-600 rounded"></div>
          <div className="h-5 w-32 bg-gray-300 dark:bg-gray-600 rounded"></div>
        </div>
        <div className="mt-2 space-y-2">
          <div className="h-4 bg-gray-300 dark:bg-gray-600 rounded w-3/4"></div>
          <div className="h-4 bg-gray-300 dark:bg-gray-600 rounded w-1/2"></div>
        </div>
      </div>
    );
  }

  const isEmpty = !report ||
    report.includes('I have no latency reports') ||
    report.includes('Sam, I have no advice') ||
    report.trim().length === 0;

  if (isEmpty) {
    return (
      <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/20 p-4">
        <div className="flex items-center gap-2 text-green-700 dark:text-green-300">
          <CheckCircle className="h-5 w-5" />
          <span className="font-medium">{title}</span>
        </div>
        <p className="mt-1 text-sm text-green-600 dark:text-green-400">No issues detected</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 p-4">
      <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300 mb-2">
        <AlertTriangle className="h-5 w-5" />
        <span className="font-medium">{title}</span>
      </div>
      <pre className="mt-2 whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300 font-mono overflow-x-auto">
        {highlightText(report)}
      </pre>
    </div>
  );
}
