import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const isWindows = process.platform === 'win32';
const MONITOR_PACKAGE = '@betterdb/monitor';
const npxCmd = isWindows ? 'npx.cmd' : 'npx';

export const BETTERDB_DIR = path.join(os.homedir(), '.betterdb');
export const PID_FILE = path.join(BETTERDB_DIR, 'monitor.pid');

// Track the current ephemeral child so signal handlers always reference the right process.
let ephemeralChild: ChildProcess | null = null;
let signalHandlersRegistered = false;

function terminate(pid: number | undefined): void {
  if (pid === undefined) return;
  if (isWindows) {
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    spawnSync(taskkill, ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
}

function commandLineOf(pid: number): string {
  const result = isWindows
    ? spawnSync(
        path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      )
    : spawnSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
  return result.stdout ?? '';
}

function isMonitorProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return commandLineOf(pid).includes(MONITOR_PACKAGE);
}

function registerEphemeralHandlers(): void {
  if (signalHandlersRegistered) return;
  signalHandlersRegistered = true;
  process.once('exit', () => { terminate(ephemeralChild?.pid); });
}

const MCP_ENV = new Set([
  'BETTERDB_URL',
  'BETTERDB_TOKEN',
  'BETTERDB_LOCAL_TOKEN',
  'BETTERDB_INSTANCE_ID',
  'BETTERDB_MCP_TELEMETRY',
]);
const MONITOR_ENV_PREFIX = 'BETTERDB_MONITOR_';
const RESERVED_MONITOR_ENV = new Set(['PORT', 'STORAGE_TYPE']);

export function monitorEnv(
  source: NodeJS.ProcessEnv,
  defaults: Record<string, string>,
): Record<string, string> {
  const inherited: Record<string, string> = {};
  const overrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const upperKey = key.toUpperCase();
    if (value === undefined || MCP_ENV.has(upperKey)) continue;
    if (upperKey.startsWith(MONITOR_ENV_PREFIX)) {
      const name = key.slice(MONITOR_ENV_PREFIX.length);
      if (name && !RESERVED_MONITOR_ENV.has(name.toUpperCase())) setEnv(overrides, name, value);
    } else {
      setEnv(inherited, key, value);
    }
  }
  const env = inherited;
  for (const [key, value] of [...Object.entries(defaults), ...Object.entries(overrides)]) {
    setEnv(env, key, value);
  }
  return env;
}

function setEnv(env: Record<string, string>, key: string, value: string): void {
  const upperKey = key.toUpperCase();
  for (const existing of Object.keys(env)) {
    if (existing.toUpperCase() === upperKey) delete env[existing];
  }
  env[key] = value;
}

async function checkHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function readValidPid(file: string): number | null {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const pid = Number(raw.split(':')[0]);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await checkHealth(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('BetterDB monitor did not start within 15s');
}

export async function startMonitor(opts: {
  persist: boolean;
  port: number;
  storage: 'sqlite' | 'memory';
}): Promise<{ url: string; alreadyRunning: boolean }> {
  const url = `http://localhost:${opts.port}`;

  // Pre-check: existing PID file
  if (fs.existsSync(PID_FILE)) {
    const raw = fs.readFileSync(PID_FILE, 'utf-8').trim();
    const [, portStr] = raw.split(':');
    const pid = readValidPid(PID_FILE);
    const existingPort = portStr ? Number(portStr) : opts.port;

    if (pid === null) {
      fs.unlinkSync(PID_FILE);
    } else {
      if (isMonitorProcess(pid)) {
        if (await checkHealth(existingPort)) {
          return { url: `http://localhost:${existingPort}`, alreadyRunning: true };
        }
        // Process is alive but unhealthy — terminate it before re-spawning
        terminate(pid);
        // Wait for the port to be released (up to 5s)
        const killDeadline = Date.now() + 5_000;
        while (Date.now() < killDeadline) {
          try { process.kill(pid, 0); } catch { break; } // process exited
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }

      fs.unlinkSync(PID_FILE);
    }
  }

  const defaults: Record<string, string> = {
    PORT: String(opts.port),
    STORAGE_TYPE: opts.storage,
    NODE_ENV: 'production',
  };

  if (opts.storage === 'sqlite') {
    const dataDir = path.join(BETTERDB_DIR, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    defaults.STORAGE_SQLITE_FILEPATH = path.join(dataDir, 'audit.db');
  }

  const env = monitorEnv(process.env, defaults);

  let child: ChildProcess;

  if (opts.persist) {
    // Persistent mode: detached, PID file written
    fs.mkdirSync(BETTERDB_DIR, { recursive: true });
    child = spawn(npxCmd, ['--yes', MONITOR_PACKAGE, '--no-setup', '--port', String(opts.port), '--storage-type', opts.storage], {
      env,
      stdio: 'ignore',
      detached: true,
      shell: isWindows,
    });
    child.unref();
    if (!child.pid) {
      throw new Error('Failed to spawn monitor process');
    }
    fs.writeFileSync(PID_FILE, `${child.pid}:${opts.port}`);

    try {
      await waitForHealth(opts.port);
    } catch (err) {
      // Health check failed — kill the orphaned child and clean up PID file
      terminate(child.pid);
      try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
      throw err;
    }
  } else {
    // Ephemeral mode: attached, cleaned up on exit
    child = spawn(npxCmd, ['--yes', MONITOR_PACKAGE, '--no-setup', '--port', String(opts.port), '--storage-type', opts.storage], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: isWindows,
    });

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (line) process.stderr.write(`[betterdb-monitor] ${line}\n`);
        }
      });
    }

    ephemeralChild = child;
    child.once('exit', () => {
      if (ephemeralChild === child) ephemeralChild = null;
    });
    registerEphemeralHandlers();

    await waitForHealth(opts.port);
  }

  return { url, alreadyRunning: false };
}

function readPidPort(file: string): number | null {
  try {
    const port = Number(fs.readFileSync(file, 'utf8').trim().split(':')[1]);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export async function stopMonitor(): Promise<{ stopped: boolean; message: string; url?: string }> {
  if (!fs.existsSync(PID_FILE)) {
    return { stopped: false, message: 'No persisted monitor found.' };
  }
  const pid = readValidPid(PID_FILE);
  const port = readPidPort(PID_FILE);
  const url = port === null ? undefined : `http://localhost:${port}`;
  if (pid === null) {
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    return { stopped: true, message: 'Removed corrupted PID file.', url };
  }
  const wasRunning = isMonitorProcess(pid);
  if (wasRunning) terminate(pid);

  if (wasRunning) {
    // Wait for process to actually exit (up to 5s)
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  try { fs.unlinkSync(PID_FILE); } catch { /* already removed */ }
  return wasRunning
    ? { stopped: true, message: `Stopped monitor (PID ${pid}).`, url }
    : { stopped: true, message: `Removed stale PID file (process ${pid} is not a running monitor).`, url };
}
