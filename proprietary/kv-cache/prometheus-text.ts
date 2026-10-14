export interface PromSample {
  metric: string;
  labels: Record<string, string>;
  value: number;
}

const PREFIX = 'lmcache:';
const SERIES = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+-?\d+)?$/;
const ESCAPES: Record<string, string> = { n: '\n', '\\': '\\', '"': '"' };

function parseLabels(body: string): Record<string, string> | null {
  const labels: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    const eq = body.indexOf('=', i);
    if (eq < 0 || body[eq + 1] !== '"') return null;
    const name = body.slice(i, eq).trim();
    let value = '';
    let j = eq + 2;
    while (j < body.length && body[j] !== '"') {
      if (body[j] === '\\' && j + 1 < body.length) {
        value += ESCAPES[body[j + 1]] ?? body[j + 1];
        j += 2;
      } else {
        value += body[j];
        j += 1;
      }
    }
    if (j >= body.length) return null;
    labels[name] = value;
    i = j + 1;
    while (i < body.length && (body[i] === ',' || body[i] === ' ')) i += 1;
  }
  return labels;
}

export function parseLmcacheMetrics(text: string): PromSample[] {
  const samples: PromSample[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith(PREFIX)) continue;
    const match = SERIES.exec(line);
    if (!match) continue;
    const [, name, labelBody, rawValue] = match;
    if (name.endsWith('_created')) continue;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    const labels = labelBody ? parseLabels(labelBody) : {};
    if (!labels) continue;
    samples.push({ metric: name.slice(PREFIX.length).replace(/_total$/, ''), labels, value });
  }
  return samples;
}
