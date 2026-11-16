import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadavg, platform } from 'node:os';

export interface HostLimits {
  maxLoad: number;
  minFreePorts: number;
}

export interface HostSample {
  at: number;
  load: number;
  freePorts: number;
}

export interface HostWindow {
  load: { start: number; max: number; end: number };
  freePorts: { start: number; min: number; end: number };
}

function output(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 20_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(new Error(`${file} ${args.join(' ')}: ${err.message}`));
      else resolve(stdout);
    });
  });
}

async function ephemeralRange(): Promise<[number, number]> {
  if (platform() === 'darwin') {
    const out = await output('sysctl', ['-n', 'net.inet.ip.portrange.first', 'net.inet.ip.portrange.last']);
    const [first, last] = out.trim().split(/\s+/).map(Number);
    return [first, last];
  }
  if (platform() === 'linux') {
    const [first, last] = readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number);
    return [first, last];
  }
  throw new Error(`the host check supports macOS and Linux, not ${platform()}`);
}

async function localPorts(): Promise<number[]> {
  const darwin = platform() === 'darwin';
  const out = darwin ? await output('netstat', ['-anp', 'tcp']) : await output('ss', ['-Htan']);
  const ports: number[] = [];
  for (const line of out.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (darwin && !columns[0].startsWith('tcp')) continue;
    const local = columns[3] ?? '';
    const port = Number(local.slice(local.lastIndexOf(darwin ? '.' : ':') + 1));
    if (Number.isInteger(port)) ports.push(port);
  }
  return ports;
}

export function countFreePorts(ports: number[], [first, last]: [number, number]): number {
  const used = new Set(ports.filter((port) => port >= first && port <= last));
  return last - first + 1 - used.size;
}

export class HostWatch {
  private readonly samples: HostSample[] = [];
  private range: Promise<[number, number]> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly limits: HostLimits,
    private readonly intervalMs = 5_000,
  ) {}

  async sample(): Promise<HostSample> {
    this.range ??= ephemeralRange();
    const range = await this.range;
    const sample = { at: Date.now(), load: loadavg()[0], freePorts: countFreePorts(await localPorts(), range) };
    this.samples.push(sample);
    return sample;
  }

  start(): void {
    this.timer ??= setInterval(() => void this.sample().catch(() => undefined), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  since(at: number): HostWindow {
    const seen = this.samples.filter((sample) => sample.at >= at).sort((a, b) => a.at - b.at);
    if (seen.length === 0) throw new Error('no host samples in the window');
    const first = seen[0];
    const last = seen[seen.length - 1];
    return {
      load: { start: first.load, max: Math.max(...seen.map((sample) => sample.load)), end: last.load },
      freePorts: {
        start: first.freePorts,
        min: Math.min(...seen.map((sample) => sample.freePorts)),
        end: last.freePorts,
      },
    };
  }

  breach(load: number, freePorts: number): string | null {
    const reasons: string[] = [];
    if (load > this.limits.maxLoad) reasons.push(`host load ${load.toFixed(1)} is over ${this.limits.maxLoad}`);
    if (freePorts < this.limits.minFreePorts) {
      reasons.push(`${freePorts} free local ports is under ${this.limits.minFreePorts}`);
    }
    return reasons.length > 0 ? reasons.join(' and ') : null;
  }
}
