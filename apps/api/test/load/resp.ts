export type Reply = string | number | null | Reply[] | { simple: string } | { error: string };

export const simple = (value: string): Reply => ({ simple: value });
export const error = (value: string): Reply => ({ error: value });
export const OK = simple('OK');

export function encodeReply(reply: Reply): string {
  if (reply === null) return '$-1\r\n';
  if (typeof reply === 'number') return `:${Math.trunc(reply)}\r\n`;
  if (typeof reply === 'string') return `$${Buffer.byteLength(reply)}\r\n${reply}\r\n`;
  if (Array.isArray(reply)) return `*${reply.length}\r\n${reply.map(encodeReply).join('')}`;
  if ('simple' in reply) return `+${reply.simple}\r\n`;
  return `-${reply.error}\r\n`;
}

export interface ParsedCommand {
  args: string[];
  bytes: number;
}

const CR = 13;

export class RespRequestParser {
  private buffer: Buffer = Buffer.alloc(0);
  private offset = 0;

  push(chunk: Buffer): void {
    this.buffer = this.offset >= this.buffer.length ? chunk : Buffer.concat([this.buffer.subarray(this.offset), chunk]);
    this.offset = 0;
  }

  next(): ParsedCommand | null {
    const start = this.offset;
    let cursor = start;
    if (cursor >= this.buffer.length) return null;

    const header = this.readLine(cursor);
    if (!header) return null;
    if (header.text[0] !== '*') return this.inline(header, start);
    cursor = header.next;

    const count = Number(header.text.slice(1));
    const args: string[] = [];
    for (let index = 0; index < count; index++) {
      const lengthLine = this.readLine(cursor);
      if (!lengthLine) return null;
      const length = Number(lengthLine.text.slice(1));
      const end = lengthLine.next + length;
      if (end + 2 > this.buffer.length) return null;
      args.push(this.buffer.toString('utf8', lengthLine.next, end));
      cursor = end + 2;
    }

    this.offset = cursor;
    return { args, bytes: cursor - start };
  }

  private inline(header: { text: string; next: number }, start: number): ParsedCommand {
    this.offset = header.next;
    return { args: header.text.trim().split(/\s+/).filter(Boolean), bytes: header.next - start };
  }

  private readLine(from: number): { text: string; next: number } | null {
    const end = this.buffer.indexOf(CR, from);
    if (end === -1 || end + 1 >= this.buffer.length) return null;
    return { text: this.buffer.toString('latin1', from, end), next: end + 2 };
  }
}
