const APP_FRAME = /at (?:async )?(\S+) \(.*?\/(?:apps\/api\/src|proprietary)\/(.*?)\.ts:\d+:\d+\)/;
const STACK_DEPTH = 50;
const FRAMES_SHOWN = 2;

export function appFrame(line: string): string | null {
  const match = APP_FRAME.exec(line.replace(/\\/g, '/'));
  if (!match || match[2].includes('database/adapters/')) return null;
  return `${match[2].split('/').pop()}: ${match[1]}`;
}

export function callSite(): string {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = STACK_DEPTH;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  const frames: string[] = [];
  for (const line of stack.split('\n')) {
    const frame = appFrame(line);
    if (!frame || frames.includes(frame)) continue;
    frames.push(frame);
    if (frames.length === FRAMES_SHOWN) break;
  }
  return frames.length ? frames.join(' < ') : 'unknown';
}
