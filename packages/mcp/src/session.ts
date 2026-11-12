import type { MonitorTarget } from './monitor-target.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const DEFAULT_URL = 'http://localhost:3001';

function monitorKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = LOOPBACK_HOSTS.has(parsed.hostname) ? 'localhost' : parsed.hostname;
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return `${parsed.protocol}//${host}:${port}`;
  } catch {
    return null;
  }
}

export function isSameMonitor(a: string, b: string): boolean {
  const key = monitorKey(a);
  return key !== null && key === monitorKey(b);
}

interface Saved {
  target: MonitorTarget;
  instanceId: string | null;
}

export class MonitorSession {
  target: MonitorTarget;
  instanceId: string | null;
  private saved: Saved | null = null;

  constructor(private readonly env: NodeJS.ProcessEnv) {
    const url = (env.BETTERDB_URL || DEFAULT_URL).replace(/\/+$/, '');
    this.target = this.targetFor(url);
    this.instanceId = this.instanceFor(url);
  }

  switchTo(url: string, remember: boolean): void {
    if (isSameMonitor(this.target.url, url)) return;
    if (remember) {
      this.saved ??= { target: this.target, instanceId: this.instanceId };
    }
    this.target = this.targetFor(url);
    this.instanceId = this.instanceFor(url);
  }

  restoreAfterStop(): MonitorTarget | null {
    if (!this.saved) return null;
    const stopped = this.target;
    this.target = this.saved.target;
    this.instanceId = this.saved.instanceId;
    this.saved = null;
    return stopped;
  }

  private isConfigured(url: string): boolean {
    const configured = this.env.BETTERDB_URL;
    return !configured || isSameMonitor(url, configured);
  }

  private targetFor(url: string): MonitorTarget {
    const token = this.isConfigured(url)
      ? this.env.BETTERDB_TOKEN
      : this.env.BETTERDB_LOCAL_TOKEN || undefined;
    return { url, token, prefix: null };
  }

  private instanceFor(url: string): string | null {
    return this.isConfigured(url) ? this.env.BETTERDB_INSTANCE_ID || null : null;
  }
}
