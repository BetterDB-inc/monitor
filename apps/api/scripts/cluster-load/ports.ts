import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

export const PORTS_EXHAUSTED = 'ran out of local ports (EADDRNOTAVAIL)';
const TIME_WAIT_SECONDS_BY_PLATFORM: Partial<Record<NodeJS.Platform, number>> = { darwin: 30, linux: 60, win32: 120 };
export const TIME_WAIT_SECONDS = TIME_WAIT_SECONDS_BY_PLATFORM[process.platform] ?? 60;

export function ephemeralPortCount(): number | null {
  try {
    if (process.platform === 'linux') {
      const [first, last] = readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number);
      return last - first + 1;
    }
    if (process.platform === 'darwin') {
      const read = (name: string): number => Number(execFileSync('sysctl', ['-n', name], { encoding: 'utf8' }).trim());
      return read('net.inet.ip.portrange.last') - read('net.inet.ip.portrange.first') + 1;
    }
  } catch {
    return null;
  }
  return null;
}

export function expectedSockets(nodes: number, mode: 'seed' | 'auto'): number {
  return mode === 'auto' ? nodes * nodes + nodes : nodes + 16;
}

export function portsHeld(socketsOpen: number, socketsOpenedPerSecond: number): number {
  return Math.round(socketsOpen + socketsOpenedPerSecond * TIME_WAIT_SECONDS);
}

export function portPressure(socketsOpen: number, socketsOpenedPerSecond: number): string | null {
  const available = ephemeralPortCount();
  if (available === null) return null;
  const held = portsHeld(socketsOpen, socketsOpenedPerSecond);
  if (held <= available / 2) return null;
  return (
    `about ${held.toLocaleString('en-US')} local ports were held, counting the ones a closed connection keeps for ` +
    `${TIME_WAIT_SECONDS}s, out of ${available.toLocaleString('en-US')}`
  );
}

export function portProblem(nodes: number, mode: 'seed' | 'auto'): string | null {
  const available = ephemeralPortCount();
  if (available === null) return null;
  const budget = Math.floor(available / 2);
  const needed = expectedSockets(nodes, mode);
  if (needed <= budget) return null;
  return (
    `needs about ${needed.toLocaleString('en-US')} local ports, this machine has ${available.toLocaleString('en-US')} ` +
    `and the test takes at most half (${budget.toLocaleString('en-US')}) so other programs can still connect`
  );
}
