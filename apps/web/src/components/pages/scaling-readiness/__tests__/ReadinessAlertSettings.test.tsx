import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReadinessAlertSettings } from '../ReadinessAlertSettings';

const settings = { connectionId: 'c', alertEnabled: true, alertThreshold: 40, updatedAt: 1 };

describe('ReadinessAlertSettings', () => {
  it('reports threshold changes', () => {
    const onChange = vi.fn();
    render(<ReadinessAlertSettings settings={settings} onChange={onChange} saveStatus="idle" />);
    fireEvent.change(screen.getByLabelText('Alert threshold'), { target: { value: '55' } });
    expect(onChange).toHaveBeenCalledWith({ alertThreshold: 55 });
  });

  it('ignores out-of-range thresholds', () => {
    const onChange = vi.fn();
    render(<ReadinessAlertSettings settings={settings} onChange={onChange} saveStatus="idle" />);
    fireEvent.change(screen.getByLabelText('Alert threshold'), { target: { value: '150' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports toggle changes', () => {
    const onChange = vi.fn();
    render(<ReadinessAlertSettings settings={settings} onChange={onChange} saveStatus="idle" />);
    fireEvent.click(screen.getByRole('switch', { name: 'Alert when the score drops' }));
    expect(onChange).toHaveBeenCalledWith({ alertEnabled: false });
  });

  it('shows the saved state', () => {
    render(<ReadinessAlertSettings settings={settings} onChange={vi.fn()} saveStatus="saved" />);
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('shows refetched server values after typing', () => {
    const { rerender } = render(
      <ReadinessAlertSettings settings={settings} onChange={vi.fn()} saveStatus="idle" />,
    );
    const input = screen.getByLabelText('Alert threshold') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '55' } });
    expect(input.value).toBe('55');
    rerender(
      <ReadinessAlertSettings
        settings={{ ...settings, alertThreshold: 30 }}
        onChange={vi.fn()}
        saveStatus="error"
      />,
    );
    expect(input.value).toBe('30');
  });
});
