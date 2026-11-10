import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const isWindows = process.platform === 'win32';
const MONITOR_PACKAGE = '@betterdb/monitor';
const COMMAND_LINE_TIMEOUT_MS = 3_000;
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
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
  }
}

function commandLineOf(pid: number): string | null {
  const result = isWindows
    ? spawnSync(
        path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: COMMAND_LINE_TIMEOUT_MS },
      )
    : spawnSync('/bin/ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: COMMAND_LINE_TIMEOUT_MS,
      });
  const commandLine = result.status === 0 ? result.stdout?.trim() : '';
  return commandLine ? commandLine.replace(/\\/g, '/') : null;
}

export type ProcessIdentity = 'monitor' | 'other' | 'unknown';

export function identifyProcess(pid: number): ProcessIdentity {
  try {
    process.kill(pid, 0);
  } catch {
    return 'other';
  }
  const commandLine = commandLineOf(pid);
  if (commandLine === null) return 'unknown';
  return commandLine.includes(MONITOR_PACKAGE) ? 'monitor' : 'other';
}

export type PortState = 'monitor' | 'free' | 'other' | 'unknown';

function isConnectionRefused(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } } | null)?.cause;
  return cause?.code === 'ECONNREFUSED';
}

export async function probePort(port: number): Promise<PortState> {
  let answered = false;
  let failed = false;
  let refused = false;
  for (const prefix of ['/api', '']) {
    try {
      const res = await fetch(`http://localhost:${port}${prefix}/mcp/instances`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok && (res.headers.get('content-type') ?? '').includes('application/json')) return 'monitor';
      answered = true;
    } catch (err) {
      if (isConnectionRefused(err)) refused = true;
      else failed = true;
    }
  }
  if (answered) return 'other';
  if (failed) return 'unknown';
  return refused ? 'free' : 'unknown';
}

export async function isBetterDbMonitor(port: number): Promise<boolean> {
  return (await probePort(port)) === 'monitor';
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitWhileRunning(
  port: number,
  isRunning: () => boolean,
  timeoutMs: number,
): Promise<'monitor' | 'exited' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning()) return 'exited';
    if ((await isBetterDbMonitor(port)) && isRunning()) return 'monitor';
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return 'timeout';
}

export async function waitForMonitor(port: number, child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  const outcome = await waitWhileRunning(port, () => !hasExited(child), timeoutMs);
  if (outcome === 'exited') {
    throw new Error(`BetterDB monitor exited before it started on port ${port}`);
  }
  if (outcome === 'timeout') {
    throw new Error(`BetterDB monitor did not start within ${Math.round(timeoutMs / 1000)}s`);
  }
}

export async function adoptRecordedMonitor(
  pid: number,
  port: number,
  timeoutMs = 15_000,
): Promise<'running' | 'gone' | 'stale'> {
  const state = await probePort(port);
  if (state === 'monitor') return 'running';
  if (state === 'unknown') {
    throw new Error(
      `Could not tell whether monitor process ${pid} is answering on port ${port}, so it was left running with its PID file. Try again.`,
    );
  }
  if (state === 'other') return 'stale';
  const outcome = await waitWhileRunning(port, () => isAlive(pid), timeoutMs);
  if (outcome === 'monitor') return 'running';
  if (outcome === 'exited') return 'gone';
  throw new Error(
    `Monitor process ${pid} has not opened port ${port} yet, so it was left running with its PID file. Try again once it has started, or stop it first.`,
  );
}

export async function startMonitor(opts: {
  persist: boolean;
  port: number;
  storage: 'sqlite' | 'memory';
}): Promise<{ url: string; alreadyRunning: boolean; owned: boolean }> {
  const url = `http://localhost:${opts.port}`;

  // Pre-check: existing PID file
  if (fs.existsSync(PID_FILE)) {
    const raw = fs.readFileSync(PID_FILE, 'utf-8').trim();
    const [, portStr] = raw.split(':');
    const pid = readValidPid(PID_FILE);
    const existingPort = portStr ? Number(portStr) : opts.port;

    const identity = pid === null ? 'other' : identifyProcess(pid);
    const recorded = pid !== null && identity === 'monitor'
      ? await adoptRecordedMonitor(pid, existingPort)
      : null;
    if (recorded === 'running') {
      return { url: `http://localhost:${existingPort}`, alreadyRunning: true, owned: true };
    }
    if (pid !== null && recorded === 'stale') {
      terminate(pid);
      const killDeadline = Date.now() + 5_000;
      while (Date.now() < killDeadline && isAlive(pid)) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (isAlive(pid)) {
        throw new Error(
          `Monitor process ${pid} is not answering on port ${existingPort} and did not stop, so it was left running with its PID file. Stop it, then try again.`,
        );
      }
    }
    if (identity === 'unknown') {
      if (await isBetterDbMonitor(existingPort)) {
        return { url: `http://localhost:${existingPort}`, alreadyRunning: true, owned: false };
      }
      throw new Error(
        `Could not read the command line of process ${pid} from ${PID_FILE}, so no new monitor was started. Stop that process or remove the PID file, then try again.`,
      );
    }
    fs.unlinkSync(PID_FILE);
  }

  const portState = await probePort(opts.port);
  if (portState === 'monitor') {
    return { url, alreadyRunning: true, owned: false };
  }
  if (portState !== 'free') {
    throw new Error(
      portState === 'other'
        ? `Port ${opts.port} is in use by something that is not BetterDB, so no monitor was started.`
        : `Could not tell whether port ${opts.port} is free, so no monitor was started. Try again.`,
    );
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
      await waitForMonitor(opts.port, child);
    } catch (err) {
      // Health check failed — kill the orphaned child and clean up PID file
      if (!hasExited(child)) terminate(child.pid);
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

    try {
      await waitForMonitor(opts.port, child);
    } catch (err) {
      if (!hasExited(child)) terminate(child.pid);
      throw err;
    }
  }

  return { url, alreadyRunning: false, owned: true };
}

function readPidPort(file: string): number | null {
  try {
    const port = Number(fs.readFileSync(file, 'utf8').trim().split(':')[1]);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export async function stopMonitor(): Promise<{
  stopped: boolean;
  identified: boolean;
  message: string;
  url?: string;
}> {
  if (!fs.existsSync(PID_FILE)) {
    return { stopped: false, identified: true, message: 'No persisted monitor found.' };
  }
  const pid = readValidPid(PID_FILE);
  const port = readPidPort(PID_FILE);
  const url = port === null ? undefined : `http://localhost:${port}`;
  if (pid === null) {
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    return { stopped: true, identified: true, message: 'Removed corrupted PID file.', url };
  }
  const identity = identifyProcess(pid);
  if (identity === 'unknown') {
    return {
      stopped: false,
      identified: false,
      message: `Could not read the command line of process ${pid}, so it was left running and the PID file was kept.`,
      url,
    };
  }
  const wasRunning = identity === 'monitor';
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
    ? { stopped: true, identified: true, message: `Stopped monitor (PID ${pid}).`, url }
    : {
        stopped: true,
        identified: true,
        message: `Removed stale PID file (process ${pid} is not a running monitor).`,
        url,
      };
}
