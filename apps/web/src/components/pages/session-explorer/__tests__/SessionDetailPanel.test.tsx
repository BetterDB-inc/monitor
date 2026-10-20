import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionDetailPanel } from '../SessionDetailPanel';
import { detail, failedKey } from './fixtures';

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

  it('exports on request', () => {
    const onExport = vi.fn();
    render(<SessionDetailPanel detail={detail()} onExport={onExport} exporting={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Export JSON/ }));
    expect(onExport).toHaveBeenCalled();
  });
});
