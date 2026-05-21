import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CapabilityStatusBanner } from './CapabilityStatusBanner';

// shadcn Button uses @/ alias which vitest doesn't resolve; mock to a plain button.
vi.mock('./ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

const baseProps = {
  featureName: 'Slow Log',
  command: 'SLOWLOG',
  reason: "ERR Command is not available: 'SLOWLOG'",
};

describe('CapabilityStatusBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the verbatim ERR in a red-toned error banner by default', () => {
    render(<CapabilityStatusBanner {...baseProps} />);

    const warn = screen.getByText(/Slow Log unavailable/).closest('[role="alert"]');
    const errorBanner = screen.getByText(baseProps.reason).closest('[role="alert"]');

    expect(warn).toBeInTheDocument();
    expect(errorBanner).toBeInTheDocument();
    expect(errorBanner?.className).toMatch(/border-red-500/);
  });

  it('hides the Retry button when onRetry is omitted', () => {
    render(<CapabilityStatusBanner {...baseProps} />);
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('shows the in-progress "Force-retrying" row during the 3s delay', async () => {
    const onRetry = vi.fn(async () => ({ available: false as const, reason: 'still blocked' }));
    render(<CapabilityStatusBanner {...baseProps} onRetry={onRetry} />);

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    expect(screen.getByText(/Force-retrying SLOWLOG/)).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeDisabled();
    expect(onRetry).not.toHaveBeenCalled();

    // After the perceptible delay the onRetry resolves.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders an amber "Couldn\'t verify" banner when the verdict is "unknown"', async () => {
    const onRetry = vi.fn(async () => ({
      available: 'unknown' as const,
      reason: 'read ECONNRESET',
    }));
    render(<CapabilityStatusBanner {...baseProps} onRetry={onRetry} />);

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    // Replaces the red error banner with an amber "couldn't verify" banner.
    expect(screen.getByText(/Couldn['’]t verify/)).toBeInTheDocument();
    // Surfaces the FRESH transient reason from the verdict, not the prop's reason.
    expect(screen.getByText('read ECONNRESET')).toBeInTheDocument();
    expect(screen.queryByText(baseProps.reason)).not.toBeInTheDocument();

    // Retry button stays available so the operator can try again.
    expect(screen.getByRole('button', { name: /retry/i })).not.toBeDisabled();
  });

  it('keeps the red banner on a definitive "available: false" verdict', async () => {
    const onRetry = vi.fn(async () => ({
      available: false as const,
      reason: 'ERR Command is not available: refreshed',
    }));
    render(<CapabilityStatusBanner {...baseProps} onRetry={onRetry} />);

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    // No "couldn't verify" copy anywhere.
    expect(screen.queryByText(/Couldn['’]t verify/)).not.toBeInTheDocument();
    // Original prop reason still shown (verdict.reason isn't surfaced on the
    // false path — the parent's refreshCapabilities will deliver the fresh
    // reason via the `reason` prop).
    expect(screen.getByText(baseProps.reason)).toBeInTheDocument();
  });

  it('falls back to the prop reason when verdict.reason is missing', async () => {
    const onRetry = vi.fn(async () => ({ available: 'unknown' as const }));
    render(<CapabilityStatusBanner {...baseProps} onRetry={onRetry} />);

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(screen.getByText(/Couldn['’]t verify/)).toBeInTheDocument();
    expect(screen.getByText(baseProps.reason)).toBeInTheDocument();
  });
});
