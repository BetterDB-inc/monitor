import { useMemo, useState } from 'react';
import { Button } from './button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './collapsible';
import { cn, formatBytes } from '../../lib/utils';

export const PREVIEW_CHARS = 2000;
export const PREVIEW_LINES = 40;

interface Props {
  text: string;
  as?: 'p' | 'pre';
  className?: string;
  previewChars?: number;
  previewLines?: number;
}

function nthNewline(text: string, n: number): number {
  let at = -1;
  for (let i = 0; i < n; i++) {
    at = text.indexOf('\n', at + 1);
    if (at === -1) return -1;
  }
  return at;
}

function graphemeStart(text: string, index: number): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return segmenter.segment(text.slice(0, index + 2)).containing(index)?.index ?? index;
}

function utf8Bytes(text: string, start: number): number {
  let bytes = 0;
  for (let i = start; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function previewEnd(text: string, chars: number, lines: number): number | null {
  const slackChars = Math.ceil(chars / 4);
  const slackLines = Math.ceil(lines / 4);
  const tooLong = text.length > chars + slackChars;
  const tooTall = nthNewline(text, lines + slackLines) !== -1;
  if (!tooLong && !tooTall) return null;
  const lineEnd = nthNewline(text, lines);
  const cut = lineEnd === -1 ? chars : Math.min(chars, lineEnd);
  return graphemeStart(text, cut);
}

export function CollapsibleText({
  text,
  as: Tag = 'p',
  className,
  previewChars = PREVIEW_CHARS,
  previewLines = PREVIEW_LINES,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const collapse = useMemo(() => {
    const cut = previewEnd(text, previewChars, previewLines);
    return cut === null ? null : { cut, hidden: formatBytes(utf8Bytes(text, cut)) };
  }, [text, previewChars, previewLines]);

  if (!collapse) return <Tag className={className}>{text}</Tag>;

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      {!expanded && (
        <Tag className={cn(className, "after:content-['…']")}>{text.slice(0, collapse.cut)}</Tag>
      )}
      <CollapsibleContent asChild>
        <Tag className={cn(className, 'max-h-96 overflow-auto')}>{text}</Tag>
      </CollapsibleContent>
      <CollapsibleTrigger asChild>
        <Button size="sm" variant="link" className="h-auto px-0 text-xs">
          {expanded ? 'Show less' : `Show more (${collapse.hidden} hidden)`}
        </Button>
      </CollapsibleTrigger>
    </Collapsible>
  );
}
