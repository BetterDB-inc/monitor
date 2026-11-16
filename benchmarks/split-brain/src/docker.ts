import { execFile } from 'node:child_process';
import { LABEL } from './config';

let halted = false;
const creating = new Set<Promise<string>>();

function call(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`docker ${args.slice(0, 4).join(' ')}: ${stderr.trim() || err.message}`));
      else resolve(stdout.trim());
    });
  });
}

const creates = (args: string[]) => args[0] === 'run' || (args[0] === 'network' && args[1] === 'create');

export function docker(args: string[], timeoutMs = 60_000): Promise<string> {
  if (halted) return Promise.reject(new Error('the run is stopping'));
  const pending = call(args, timeoutMs);
  if (creates(args)) {
    creating.add(pending);
    const forget = () => creating.delete(pending);
    pending.then(forget, forget);
  }
  return pending;
}

export async function haltDocker(): Promise<void> {
  halted = true;
  await Promise.allSettled([...creating]);
}

export function rootExec(container: string, script: string, timeoutMs = 20_000): Promise<string> {
  return docker(['exec', '-u', '0', container, 'sh', '-c', script], timeoutMs);
}

export function exec(container: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return docker(['exec', container, ...args], timeoutMs);
}

function assertOwned(names: string[]): void {
  for (const name of names) {
    if (!name.startsWith('sbb-')) throw new Error(`refusing to touch ${name}: not a bench resource`);
  }
}

export async function removeContainers(namePrefix: string): Promise<void> {
  if (!namePrefix.startsWith('sbb-')) throw new Error(`refusing prefix ${namePrefix}`);
  const listed = await call(
    ['ps', '-a', '--filter', `label=${LABEL}`, '--filter', `name=^${namePrefix}`, '--format', '{{.Names}}'],
    60_000,
  );
  const names = listed.split('\n').filter(Boolean);
  if (names.length === 0) return;
  assertOwned(names);
  await call(['rm', '-f', '-v', ...names], 120_000);
}

export async function removeNetworks(): Promise<void> {
  const listed = await call(['network', 'ls', '--filter', `label=${LABEL}`, '--format', '{{.Name}}'], 60_000);
  const names = listed.split('\n').filter(Boolean);
  if (names.length === 0) return;
  assertOwned(names);
  await call(['network', 'rm', ...names], 60_000);
}
