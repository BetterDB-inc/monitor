import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { formatBytes } from '../../lib/utils';
import { CollapsibleText, PREVIEW_CHARS, PREVIEW_LINES } from './collapsible-text';

const slackChars = PREVIEW_CHARS / 4;
const slackLines = PREVIEW_LINES / 4;
const showMore = () => screen.getByRole('button', { name: /show more/i });
const utf8 = (s: string) => new TextEncoder().encode(s).byteLength;

describe('CollapsibleText', () => {
  it('shows short text in full with no toggle', () => {
    render(<CollapsibleText text="hello" />);
    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('does not collapse when only a little text would be hidden', () => {
    const text = 'a'.repeat(PREVIEW_CHARS + slackChars);
    render(<CollapsibleText text={text} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('collapses once the hidden part is meaningful', () => {
    render(<CollapsibleText text={'a'.repeat(PREVIEW_CHARS + slackChars + 1)} />);
    expect(screen.getByText('a'.repeat(PREVIEW_CHARS))).toBeInTheDocument();
    expect(showMore()).toBeInTheDocument();
  });

  it('collapses many short lines to a bounded number of lines', () => {
    const lines = Array.from({ length: PREVIEW_LINES + slackLines + 1 }, (_, i) => `line ${i}`);
    const { container } = render(<CollapsibleText as="pre" text={lines.join('\n')} />);
    expect(container.querySelector('pre')?.textContent).toBe(
      lines.slice(0, PREVIEW_LINES).join('\n'),
    );
    expect(showMore()).toBeInTheDocument();
  });

  it('keeps a few lines past the cap in full', () => {
    const text = Array.from({ length: PREVIEW_LINES + slackLines }, () => 'x').join('\n');
    render(<CollapsibleText as="pre" text={text} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('labels the size of the hidden part in UTF-8 bytes', () => {
    const tail = 'é😀z'.repeat(1_000);
    render(<CollapsibleText text={'a'.repeat(PREVIEW_CHARS) + tail} />);
    expect(showMore()).toHaveAccessibleName(`Show more (${formatBytes(utf8(tail))} hidden)`);
  });

  it('keeps the ellipsis out of the copied text', () => {
    const { container } = render(<CollapsibleText text={'a'.repeat(PREVIEW_CHARS * 2)} />);
    expect(container.querySelector('p')?.textContent).toBe('a'.repeat(PREVIEW_CHARS));
  });

  it('does not split a grapheme cluster at the cut', () => {
    const text = 'a'.repeat(PREVIEW_CHARS - 2) + '🇧🇬' + 'b'.repeat(PREVIEW_CHARS);
    const { container } = render(<CollapsibleText text={text} />);
    expect(container.querySelector('p')?.textContent).toBe('a'.repeat(PREVIEW_CHARS - 2));
  });

  it('expands into a bounded scroll box and collapses again', () => {
    const text = 'a'.repeat(PREVIEW_CHARS * 2) + 'TAIL';
    render(<CollapsibleText text={text} />);
    expect(screen.queryByText(/TAIL/)).not.toBeInTheDocument();
    fireEvent.click(showMore());
    expect(screen.getByText(/TAIL/)).toHaveClass('max-h-96', 'overflow-auto');
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.queryByText(/TAIL/)).not.toBeInTheDocument();
  });

  it('points the toggle at the content it controls', () => {
    render(<CollapsibleText text={'a'.repeat(PREVIEW_CHARS * 2)} />);
    fireEvent.click(showMore());
    const id = screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-controls');
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)).toHaveTextContent('a'.repeat(PREVIEW_CHARS * 2));
  });

  it('accepts a smaller preview', () => {
    render(<CollapsibleText text={'a'.repeat(300)} previewChars={200} />);
    expect(screen.getByText('a'.repeat(200))).toBeInTheDocument();
    expect(showMore()).toBeInTheDocument();
  });
});
