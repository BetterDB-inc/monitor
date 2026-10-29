import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ParsedMessage } from '@betterdb/shared';
import { PREVIEW_CHARS } from '../../../ui/collapsible-text';
import { MessageTimeline } from '../MessageTimeline';

const long = 'a'.repeat(PREVIEW_CHARS * 2) + 'TAIL';

describe('MessageTimeline', () => {
  it('shows a short message in full with no toggle', () => {
    render(<MessageTimeline messages={[{ role: 'human', content: 'hello' }]} />);
    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument();
  });

  it('collapses a long message until asked to expand it', () => {
    render(<MessageTimeline messages={[{ role: 'ai', content: long }]} />);
    expect(screen.queryByText(/TAIL/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /show more/i }));
    expect(screen.getByText(/TAIL/)).toBeInTheDocument();
  });

  it('collapses long tool call arguments', () => {
    const message: ParsedMessage = {
      role: 'ai',
      content: '',
      toolCalls: [{ id: 'c1', name: 'search', args: { query: long } }],
    };
    render(<MessageTimeline messages={[message]} />);
    expect(screen.getByTestId('tool-call-c1')).not.toHaveTextContent('TAIL');
    fireEvent.click(screen.getByRole('button', { name: /show more/i }));
    expect(screen.getByTestId('tool-call-c1')).toHaveTextContent('TAIL');
  });

  it('shows no arguments block for a tool call without args', () => {
    const message: ParsedMessage = {
      role: 'ai',
      content: '',
      toolCalls: [{ id: 'c1', name: 'ping', args: undefined }],
    };
    render(<MessageTimeline messages={[message]} />);
    expect(screen.getByTestId('tool-call-c1')).not.toHaveTextContent('undefined');
    expect(screen.getByTestId('tool-call-c1').querySelector('pre')).toBeNull();
  });
});
