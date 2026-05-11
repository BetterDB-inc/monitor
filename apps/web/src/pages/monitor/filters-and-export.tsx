import { useMemo, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { ExportFilters, buildExportUrl } from '../../api/monitor';

interface Props {
  sessionId: string;
  /** Lines currently visible in the live tail buffer; used for the in-page filtered count preview. */
  bufferLines: string[];
}

export function FiltersAndExport({ sessionId, bufferLines }: Props) {
  const [command, setCommand] = useState('');
  const [client, setClient] = useState('');
  const [key, setKey] = useState('');
  const [afterIso, setAfterIso] = useState('');
  const [beforeIso, setBeforeIso] = useState('');

  const filters: ExportFilters = useMemo(() => {
    const f: ExportFilters = {};
    if (command.trim()) f.command = command.trim();
    if (client.trim()) f.client = client.trim();
    if (key.trim()) f.key = key.trim();
    const after = parseDateTimeLocal(afterIso);
    const before = parseDateTimeLocal(beforeIso);
    if (after !== null) f.afterTs = after;
    if (before !== null) f.beforeTs = before;
    return f;
  }, [command, client, key, afterIso, beforeIso]);

  const filteredCount = useMemo(
    () => countFilteredInBuffer(bufferLines, filters),
    [bufferLines, filters],
  );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Command" value={command} onChange={setCommand} placeholder="GET" />
        <Field label="Client" value={client} onChange={setClient} placeholder="192.168 or :50000" />
        <Field label="Key glob" value={key} onChange={setKey} placeholder="user:*" />
        <Field
          label="After"
          value={afterIso}
          onChange={setAfterIso}
          type="datetime-local"
          placeholder=""
        />
        <Field
          label="Before"
          value={beforeIso}
          onChange={setBeforeIso}
          type="datetime-local"
          placeholder=""
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {Object.keys(filters).length === 0
            ? `No filters — ${bufferLines.length.toLocaleString()} buffered lines.`
            : `Buffer match: ${filteredCount.toLocaleString()} of ${bufferLines.length.toLocaleString()} lines. Export uses the full session, server-side.`}
        </p>
        <div className="flex gap-2">
          <a href={buildExportUrl(sessionId, 'json', filters)} download>
            <Button size="sm" variant="outline">
              Export JSON
            </Button>
          </a>
          <a href={buildExportUrl(sessionId, 'csv', filters)} download>
            <Button size="sm" variant="outline">
              Export CSV
            </Button>
          </a>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  type?: string;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

function parseDateTimeLocal(s: string): number | null {
  if (!s) return null;
  const ms = new Date(s).getTime();
  return isNaN(ms) ? null : ms;
}

/**
 * Count buffered lines that would match the filters. Mirror the server-side
 * parser inline so we don't have to round-trip during typing — purely for the
 * "buffer match: X" preview. Export still uses the server endpoint and sees
 * every persisted chunk.
 */
function countFilteredInBuffer(lines: string[], filters: ExportFilters): number {
  if (Object.keys(filters).length === 0) return lines.length;
  let count = 0;
  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    if (filters.command && parsed.cmd !== filters.command.toUpperCase()) continue;
    if (filters.client && !parsed.addr.includes(filters.client)) continue;
    if (filters.key) {
      if (parsed.key === null) continue;
      if (!globMatch(parsed.key, filters.key)) continue;
    }
    if (filters.afterTs !== undefined && parsed.ts < filters.afterTs) continue;
    if (filters.beforeTs !== undefined && parsed.ts > filters.beforeTs) continue;
    count++;
  }
  return count;
}

const HEADER_RE = /^([0-9.]+)\s+\[(\d+)\s+(.+?)\]\s+(".+)$/;

interface MiniParsed {
  ts: number;
  addr: string;
  cmd: string;
  key: string | null;
}

function parseLine(line: string): MiniParsed | null {
  const m = line.match(HEADER_RE);
  if (!m) return null;
  const ts = Math.round(parseFloat(m[1]) * 1000);
  const addr = m[3];
  const tokens = parseQuoted(m[4]);
  if (tokens.length === 0) return null;
  return { ts, addr, cmd: tokens[0].toUpperCase(), key: tokens[1] ?? null };
}

function parseQuoted(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] !== '"') return out;
    i++;
    let buf = '';
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < s.length) {
        buf += s[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') {
        i++;
        break;
      }
      buf += ch;
      i++;
    }
    out.push(buf);
  }
  return out;
}

function globMatch(s: string, glob: string): boolean {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(s);
}
