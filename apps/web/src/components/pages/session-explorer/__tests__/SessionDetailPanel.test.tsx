import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionDetailPanel } from '../SessionDetailPanel';
import { detail, failedKey, parsedKey } from './fixtures';

describe('SessionDetailPanel', () => {
  it('shows tool calls as a structured block with pretty-printed args', () => {
    render(<SessionDetailPanel detail={detail()} onExport={vi.fn()} exporting={false} />);
    const block = screen.getByTestId('tool-call-call-1');
    expect(block.textContent).toContain('get_weather');
    expect(block.querySelector('pre')?.textContent).toBe(JSON.stringify({ city: 'Sofia' }, null, 2));
  });

  it('shows the token estimate', () => {
    render(<SessionDetailPanel detail={detail()} onExport={vi.fn()} exporting={false} />);
    expect(screen.getByText(/~42 tokens/)).toBeInTheDocument();
  });

  it('shows the session totals and how much of it the timeline reads', () => {
    render(
      <SessionDetailPanel
        detail={detail({
          totalKeys: 4,
          skippedKeys: 3,
          totalMemoryBytes: 4577,
          memoryBytes: 1618,
          selection: 'latest checkpoint and its pending writes',
        })}
        onExport={vi.fn()}
        exporting={false}
      />,
    );
    expect(screen.getByText(/4\.47 KB · TTL 5s · 4 keys/)).toBeInTheDocument();
    expect(
      screen.getByText(/showing latest checkpoint and its pending writes \(1 key · 1\.58 KB\)/),
    ).toBeInTheDocument();
  });

  it('marks the session memory as a lower bound when keys could not be measured', () => {
    render(
      <SessionDetailPanel
        detail={detail({ totalKeys: 4, totalMemoryBytes: 4577, unmeasuredKeys: 2 })}
        onExport={vi.fn()}
        exporting={false}
      />,
    );
    expect(screen.getByTitle('2 keys could not be measured').textContent).toBe('≥ 4.47 KB');
  });

  it('does not mention a checkpoint when every key was read', () => {
    render(<SessionDetailPanel detail={detail()} onExport={vi.fn()} exporting={false} />);
    expect(screen.queryByText(/latest checkpoint/)).toBeNull();
  });

  it('does not mention a checkpoint when keys are missing but none were skipped', () => {
    render(
      <SessionDetailPanel
        detail={detail({ totalKeys: 3, missingKeys: 2, complete: false })}
        onExport={vi.fn()}
        exporting={false}
      />,
    );
    expect(screen.queryByText(/latest checkpoint/)).toBeNull();
  });

  it('shows pending interrupts as requests for input after the messages', () => {
    render(
      <SessionDetailPanel
        detail={detail({
          interrupts: [{ value: 'Confirm the booking?' }, { value: { seats: 2 } }, {}],
        })}
        onExport={vi.fn()}
        exporting={false}
      />,
    );
    const first = screen.getByTestId('interrupt-0');
    expect(first.textContent).toContain('Waiting for input');
    expect(first.textContent).toContain('Confirm the booking?');
    expect(screen.getByTestId('interrupt-1').textContent).toContain('{\n  "seats": 2\n}');
    expect(screen.getByTestId('interrupt-2').textContent).toBe('Waiting for input');
  });

  it('shows a message with the role interrupt as an ordinary message', () => {
    render(
      <SessionDetailPanel
        detail={detail({ messages: [{ role: 'interrupt', content: 'a user role' }] })}
        onExport={vi.fn()}
        exporting={false}
      />,
    );
    expect(screen.getByText('a user role')).toBeInTheDocument();
    expect(screen.queryByTestId('interrupt-0')).toBeNull();
  });

  it('shows interrupts even when the timeline holds no messages', () => {
    render(
      <SessionDetailPanel
        detail={detail({ messages: [], interrupts: [{ value: 'Proceed?' }] })}
        onExport={vi.fn()}
        exporting={false}
      />,
    );
    expect(screen.queryByText('No messages.')).toBeNull();
    expect(screen.getByTestId('interrupt-0').textContent).toContain('Proceed?');
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
});
