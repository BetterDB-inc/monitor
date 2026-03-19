import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const BETTERDB_DIR = path.join(os.homedir(), '.betterdb');
export const PID_FILE = path.join(BETTERDB_DIR, 'monitor.pid');

// Track the current ephemeral child so signal handlers always reference the right process.
let ephemeralChild: ChildProcess | null = null;
let signalHandlersRegistered = false;

function registerEphemeralHandlers(): void {
  if (signalHandlersRegistered) return;
  signalHandlersRegistered = true;
  process.once('exit', () => { ephemeralChild?.kill(); });
  process.once('SIGTERM', () => { ephemeralChild?.kill(); process.exit(0); });
  process.once('SIGINT', () => { ephemeralChild?.kill(); process.exit(0); });
}

async function checkHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
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
    const pid = Number(fs.readFileSync(PID_FILE, 'utf-8').trim());
    let processAlive = false;
    try {
      process.kill(pid, 0);
      processAlive = true;
    } catch {
      // Process not running
    }

    if (processAlive) {
      if (await checkHealth(opts.port)) {
        return { url, alreadyRunning: true };
      }
      // Process is alive but unhealthy — terminate it before re-spawning
      try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
      // Wait for the port to be released (up to 5s)
      const killDeadline = Date.now() + 5_000;
      while (Date.now() < killDeadline) {
        try { process.kill(pid, 0); } catch { break; } // process exited
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }

    fs.unlinkSync(PID_FILE);
  }

  // Build env — filter out undefined values from process.env
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>,
    PORT: String(opts.port),
    STORAGE_TYPE: opts.storage,
    NODE_ENV: 'production',
  };

  if (opts.storage === 'sqlite') {
    const dataDir = path.join(BETTERDB_DIR, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    env.STORAGE_SQLITE_FILEPATH = path.join(dataDir, 'audit.db');
  }

  let child: ChildProcess;

  if (opts.persist) {
    // Persistent mode: detached, PID file written
    fs.mkdirSync(BETTERDB_DIR, { recursive: true });
    child = spawn('npx', ['@betterdb/monitor', '--no-setup', '--port', String(opts.port), '--storage-type', opts.storage], {
      env,
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    if (!child.pid) {
      throw new Error('Failed to spawn monitor process');
    }
    fs.writeFileSync(PID_FILE, String(child.pid));

    try {
      await waitForHealth(opts.port);
    } catch (err) {
      // Health check failed — kill the orphaned child and clean up PID file
      try { process.kill(child.pid!, 'SIGTERM'); } catch { /* already dead */ }
      try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
      throw err;
    }
  } else {
    // Ephemeral mode: attached, cleaned up on exit
    child = spawn('npx', ['@betterdb/monitor', '--no-setup', '--port', String(opts.port), '--storage-type', opts.storage], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (line) process.stderr.write(`[betterdb-monitor] ${line}\n`);
        }
      });
    }

    ephemeralChild = child;
    registerEphemeralHandlers();

    await waitForHealth(opts.port);
  }

  return { url, alreadyRunning: false };
}

export async function stopMonitor(): Promise<{ stopped: boolean; message: string }> {
  if (!fs.existsSync(PID_FILE)) {
    return { stopped: false, message: 'No persisted monitor found.' };
  }
  const pid = Number(fs.readFileSync(PID_FILE, 'utf-8').trim());
  let wasRunning = false;
  try {
    process.kill(pid, 0);
    wasRunning = true;
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process not running — stale PID file
  }

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
    ? { stopped: true, message: `Stopped monitor (PID ${pid}).` }
    : { stopped: true, message: `Removed stale PID file (process ${pid} was not running).` };
}
