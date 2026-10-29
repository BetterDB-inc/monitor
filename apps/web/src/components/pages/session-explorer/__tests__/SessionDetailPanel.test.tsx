import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PREVIEW_CHARS } from '../../../ui/collapsible-text';
import { SessionDetailPanel } from '../SessionDetailPanel';
import { detail, failedKey, parsedKey } from './fixtures';

describe('SessionDetailPanel', () => {
  it('shows tool calls as a structured block with pretty-printed args', () => {
    render(<SessionDetailPanel detail={detail()} onExport={vi.fn()} exporting={false} />);
    const block = screen.getByTestId('tool-call-call-1');
    expect(block.textContent).toContain('get_weather');
    expect(block.querySelector('pre')?.textContent).toBe(JSON.stringify({ city: 'Sofia' }, null, 2));
  });

  it('titles the session by its id without the namespace prefix', () => {
    render(
      <SessionDetailPanel
        detail={detail({ sessionId: 'message_store:support-0296' })}
        onExport={vi.fn()}
        exporting={false}
        idPrefix="message_store:"
      />,
    );
    expect(screen.getByText('support-0296')).toHaveAttribute('title', 'message_store:support-0296');
    expect(screen.getByText('message_store:support-0296')).toBeInTheDocument();
  });

  it('does not repeat the id when nothing was stripped', () => {
    render(
      <SessionDetailPanel
        detail={detail({ sessionId: 'support-0296' })}
        onExport={vi.fn()}
        exporting={false}
        idPrefix="message_store:"
      />,
    );
    expect(screen.getAllByText('support-0296')).toHaveLength(1);
  });

  it('shows the token estimate', () => {
    render(<SessionDetailPanel detail={detail()} onExport={vi.fn()} exporting={false} />);
    expect(screen.getByText(/~42 tokens/)).toBeInTheDocument();
  });

  it('warns when the timeline is incomplete', () => {
    render(
      <SessionDetailPanel
        detail={detail({ complete: false, unparsedKeys: 1, keys: [failedKey()] })}
        onExport={vi.fn()}
        exporting={false}
      />,
    );
    expect(screen.getByText(/Timeline incomplete/)).toBeInTheDocument();
    expect(screen.getByText(/1 key could not be parsed/)).toBeInTheDocument();
  });

  it('renders each message once, not again inside every key', () => {
    const key = parsedKey();
    render(
      <SessionDetailPanel
        detail={detail({ keys: [key], messages: key.parsed ? key.messages : [] })}
        onExport={vi.fn()}
        exporting={false}
      />,
    );
    expect(screen.getAllByText('Where should I stay?')).toHaveLength(1);
  });

  it('says when viewing the session reset its access time', () => {
    render(
      <SessionDetailPanel
        detail={detail({ touchesKeys: true })}
        onExport={vi.fn()}
        exporting={false}
      />,
    );
    expect(screen.getByText(/could not use CLIENT NO-TOUCH/i)).toBeInTheDocument();
  });

  it('says nothing about access times when reads used NO-TOUCH', () => {
    render(<SessionDetailPanel detail={detail()} onExport={vi.fn()} exporting={false} />);
    expect(screen.queryByText(/reset the idle time/i)).not.toBeInTheDocument();
  });

  it('exports on request', () => {
    const onExport = vi.fn();
    render(<SessionDetailPanel detail={detail()} onExport={onExport} exporting={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Export JSON/ }));
    expect(onExport).toHaveBeenCalled();
  });

  it('collapses an expanded message when switching to another session', () => {
    const messages = [{ role: 'system', content: 'a'.repeat(PREVIEW_CHARS * 2) + 'TAIL' }];
    const props = { onExport: vi.fn(), exporting: false };
    const { rerender } = render(
      <SessionDetailPanel detail={detail({ sessionId: 'chat:1', messages })} {...props} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /show more/i }));
    expect(screen.getByText(/TAIL/)).toBeInTheDocument();
    rerender(<SessionDetailPanel detail={detail({ sessionId: 'chat:2', messages })} {...props} />);
    expect(screen.queryByText(/TAIL/)).not.toBeInTheDocument();
  });
});
