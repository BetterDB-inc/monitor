import { useMemo, useState } from 'react';
import { Button } from '../../ui/button';
import { formatBytes } from '../../../lib/utils';

export const COLLAPSE_AT_CHARS = 2000;

interface Props {
  text: string;
  as?: 'p' | 'pre';
  className?: string;
}

export function CollapsibleText({ text, as: Tag = 'p', className }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [prevText, setPrevText] = useState(text);
  if (prevText !== text) {
    setPrevText(text);
    setExpanded(false);
  }
  const collapsible = text.length > COLLAPSE_AT_CHARS;
  const byteSize = useMemo(
    () => (collapsible ? formatBytes(new TextEncoder().encode(text).byteLength) : ''),
    [text, collapsible],
  );
  const last = text.charCodeAt(COLLAPSE_AT_CHARS - 1);
  const cut = last >= 0xd800 && last <= 0xdbff ? COLLAPSE_AT_CHARS - 1 : COLLAPSE_AT_CHARS;
  const shown = collapsible && !expanded ? `${text.slice(0, cut)}…` : text;
  return (
    <>
      <Tag className={className}>{shown}</Tag>
      {collapsible && (
        <Button
          size="sm"
          variant="link"
          className="h-auto px-0 text-xs"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? 'Show less' : `Show more (${byteSize})`}
        </Button>
      )}
    </>
  );
}
