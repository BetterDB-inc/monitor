import { execFile } from 'node:child_process';
import { LABEL } from './config';

export function docker(args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`docker ${args.slice(0, 4).join(' ')}: ${stderr.trim() || err.message}`));
      else resolve(stdout.trim());
    });
  });
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
  const listed = await docker([
    'ps',
    '-a',
    '--filter',
    `label=${LABEL}`,
    '--filter',
    `name=^${namePrefix}`,
    '--format',
    '{{.Names}}',
  ]);
  const names = listed.split('\n').filter(Boolean);
  if (names.length === 0) return;
  assertOwned(names);
  await docker(['rm', '-f', '-v', ...names], 120_000);
}

export async function removeNetworks(): Promise<void> {
  const listed = await docker(['network', 'ls', '--filter', `label=${LABEL}`, '--format', '{{.Name}}']);
  const names = listed.split('\n').filter(Boolean);
  if (names.length === 0) return;
  assertOwned(names);
  await docker(['network', 'rm', ...names]);
}
