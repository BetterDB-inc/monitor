import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ParsedMessage } from '@betterdb/shared';
import { MessageTimeline } from '../MessageTimeline';

const long = 'a'.repeat(5_000) + 'TAIL';

describe('MessageTimeline', () => {
  it('shows a short message in full with no toggle', () => {
    render(<MessageTimeline messages={[{ role: 'human', content: 'hello' }]} />);
    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument();
  });

  it('collapses a long message and notes its full size', () => {
    render(<MessageTimeline messages={[{ role: 'ai', content: long }]} />);
    expect(screen.queryByText(/TAIL/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show more (4.89 KB)' })).toBeInTheDocument();
  });

  it('expands and collapses a long message on request', () => {
    render(<MessageTimeline messages={[{ role: 'ai', content: long }]} />);
    fireEvent.click(screen.getByRole('button', { name: /show more/i }));
    expect(screen.getByText(/TAIL/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.queryByText(/TAIL/)).not.toBeInTheDocument();
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

  it('renders a message at the collapse threshold in full', () => {
    const atLimit = 'b'.repeat(2_000);
    render(<MessageTimeline messages={[{ role: 'ai', content: atLimit }]} />);
    expect(screen.getByText(atLimit)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument();
  });

  it('collapses a message one character past the threshold', () => {
    render(<MessageTimeline messages={[{ role: 'ai', content: 'c'.repeat(2_001) }]} />);
    expect(screen.getByText('c'.repeat(2_000) + '…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show more/i })).toBeInTheDocument();
  });

  it('does not split a surrogate pair at the collapse boundary', () => {
    const text = 'a'.repeat(1_999) + '😀' + 'b'.repeat(10);
    render(<MessageTimeline messages={[{ role: 'ai', content: text }]} />);
    expect(screen.getByText('a'.repeat(1_999) + '…')).toBeInTheDocument();
  });

  it('collapses again when the messages change', () => {
    const { rerender } = render(<MessageTimeline messages={[{ role: 'ai', content: long }]} />);
    fireEvent.click(screen.getByRole('button', { name: /show more/i }));
    expect(screen.getByText(/TAIL/)).toBeInTheDocument();
    rerender(<MessageTimeline messages={[{ role: 'ai', content: long + 'NEXT' }]} />);
    expect(screen.queryByText(/NEXT/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show more/i })).toBeInTheDocument();
  });
});
