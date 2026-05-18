import { useQuery } from '@tanstack/react-query';
import { monitorApi, PreflightMonitorSupport } from '../../api/monitor';

interface Props {
  connectionId: string | undefined;
}

interface Style {
  dot: string;
  text: string;
  label: string;
}

const STYLES: Record<PreflightMonitorSupport['status'] | 'loading', Style> = {
  yes: {
    dot: 'bg-emerald-500',
    text: 'text-emerald-700 dark:text-emerald-300',
    label: 'MONITOR available',
  },
  no: {
    dot: 'bg-red-500',
    text: 'text-red-700 dark:text-red-300',
    label: 'MONITOR unavailable',
  },
  unknown: {
    dot: 'bg-amber-500',
    text: 'text-amber-700 dark:text-amber-300',
    label: 'MONITOR support unknown',
  },
  loading: {
    dot: 'bg-muted-foreground/40',
    text: 'text-muted-foreground',
    label: 'Checking MONITOR support…',
  },
};

export function MonitorSupportIndicator({ connectionId }: Props) {
  const query = useQuery({
    queryKey: ['monitor', 'support', connectionId ?? 'none'],
    queryFn: () => monitorApi.probeMonitorSupport(connectionId as string),
    enabled: !!connectionId,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  if (!connectionId) {
    return null;
  }

  const support = query.data;
  const styleKey = support?.status ?? 'loading';
  const style = STYLES[styleKey];
  const title = support?.detail
    ? `${style.label} — ${support.detail} (source: ${support.source})`
    : style.label;

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs ${style.text}`}
      title={title}
    >
      <span className={`h-2 w-2 rounded-full ${style.dot}`} aria-hidden />
      {style.label}
    </span>
  );
}
