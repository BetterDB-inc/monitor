import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AnomalyDetectorConfigEntry } from '@betterdb/shared';
import { renderWithQuery } from '../../../../test/test-utils';
import { DetectorPanel } from './DetectorPanel';

const { api } = vi.hoisted(() => ({
  api: {
    updateAnomalyDetectors: vi.fn(),
    resetAnomalyDetector: vi.fn(),
  },
}));

vi.mock('../../../../api/settings', () => ({ settingsApi: api }));

const connections: AnomalyDetectorConfigEntry = {
  warningZScore: 2,
  criticalZScore: 3,
  consecutiveRequired: 3,
  cooldownMs: 60000,
};

const aclDenied: AnomalyDetectorConfigEntry = {
  warningZScore: 1.5,
  criticalZScore: 2.5,
  warningAbsolute: 10,
  criticalAbsolute: 50,
  consecutiveRequired: 2,
  cooldownMs: 30000,
};

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof DetectorPanel>> = {},
) {
  const props: React.ComponentProps<typeof DetectorPanel> = {
    metric: 'connections',
    defaults: connections,
    resolved: connections,
    hasOverride: false,
    open: true,
    onOpenChange: vi.fn(),
    ...overrides,
  };
  const result = renderWithQuery(<DetectorPanel {...props} />);
  return { ...result, props };
}

function warningZ() {
  return screen.getByLabelText('Warning z-score') as HTMLInputElement;
}

describe('DetectorPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    api.updateAnomalyDetectors.mockReset().mockResolvedValue({ message: 'ok', config: {} });
    api.resetAnomalyDetector.mockReset().mockResolvedValue({ message: 'ok', config: {} });
  });

  it('shows the metric key, customized dot and summary when collapsed', () => {
    renderPanel({ resolved: { ...connections, warningZScore: 2.5 }, open: false });
    expect(screen.getByText('connections')).toBeInTheDocument();
    expect(screen.getByTestId('customized-dot')).toHaveAttribute('data-customized', 'true');
    expect(screen.getByText('z 2.5 / 3')).toBeInTheDocument();
    expect(screen.queryByLabelText('Warning z-score')).not.toBeInTheDocument();
  });

  it('shows a hollow dot for a metric on defaults', () => {
    renderPanel({ open: false });
    expect(screen.getByTestId('customized-dot')).toHaveAttribute('data-customized', 'false');
  });

  it('saves only the changed field in the PATCH', async () => {
    renderPanel();
    fireEvent.change(warningZ(), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updateAnomalyDetectors).toHaveBeenCalledWith({
        connections: { warningZScore: 2.5 },
      }),
    );
  });

  it('resets instead of patching when every value equals the default', async () => {
    renderPanel({ resolved: { ...connections, warningZScore: 2.5 }, hasOverride: true });
    fireEvent.change(warningZ(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.resetAnomalyDetector).toHaveBeenCalledWith('connections'));
    expect(api.updateAnomalyDetectors).not.toHaveBeenCalled();
  });

  it('keeps unsaved edits across collapse and shows the unsaved marker', () => {
    const { rerender, props } = renderPanel();
    fireEvent.change(warningZ(), { target: { value: '2.5' } });
    rerender(<DetectorPanel {...props} open={false} />);
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
    rerender(<DetectorPanel {...props} open />);
    expect(warningZ().value).toBe('2.5');
  });

  it('shows the API error inline and keeps the typed value', async () => {
    api.updateAnomalyDetectors.mockRejectedValue(
      new Error('criticalZScore must be greater than warningZScore'),
    );
    renderPanel();
    fireEvent.change(warningZ(), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('criticalZScore must be greater than warningZScore'),
    ).toBeInTheDocument();
    expect(warningZ().value).toBe('2.5');
  });

  it('clears the save error once the user edits a field', async () => {
    api.updateAnomalyDetectors.mockRejectedValue(new Error('save failed'));
    renderPanel();
    fireEvent.change(warningZ(), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('save failed')).toBeInTheDocument();
    fireEvent.change(warningZ(), { target: { value: '2.4' } });
    expect(screen.queryByText('save failed')).not.toBeInTheDocument();
  });

  it('clears the save error once the user toggles an absolute threshold', async () => {
    api.updateAnomalyDetectors.mockRejectedValue(new Error('save failed'));
    renderPanel();
    fireEvent.change(warningZ(), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('save failed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Warning above enabled' }));
    expect(screen.queryByText('save failed')).not.toBeInTheDocument();
  });

  it('keeps an edit made while the save is pending', async () => {
    let finish: (value: unknown) => void = () => {};
    api.updateAnomalyDetectors.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderPanel();
    fireEvent.change(warningZ(), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.change(warningZ(), { target: { value: '2.7' } });
    finish({ message: 'ok', config: {} });
    await waitFor(() => expect(api.updateAnomalyDetectors).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled());
    expect(warningZ().value).toBe('2.7');
  });

  it('warns about lifetime counters only on those metrics', () => {
    const { unmount } = renderPanel({ metric: 'acl_denied', defaults: aclDenied, resolved: aclDenied });
    expect(screen.getByText(/lifetime total since the server's last restart/)).toBeInTheDocument();
    unmount();
    renderPanel();
    expect(screen.queryByText(/lifetime total/)).not.toBeInTheDocument();
  });

  it('disables Save and shows the range while a value is invalid', () => {
    renderPanel();
    fireEvent.change(warningZ(), { target: { value: '20' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText('Must be between 0.5 and 10')).toBeInTheDocument();
  });

  it('disables Save when nothing changed', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('turning an absolute threshold off sends 0', async () => {
    renderPanel({ metric: 'acl_denied', defaults: aclDenied, resolved: aclDenied });
    fireEvent.click(screen.getByRole('switch', { name: 'Critical above enabled' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updateAnomalyDetectors).toHaveBeenCalledWith({
        acl_denied: { criticalAbsolute: 0 },
      }),
    );
  });

  it('resets one metric without confirmation', async () => {
    const confirm = vi.fn();
    vi.stubGlobal('confirm', confirm);
    renderPanel({ resolved: { ...connections, warningZScore: 2.5 }, hasOverride: true });
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    await waitFor(() => expect(api.resetAnomalyDetector).toHaveBeenCalledWith('connections'));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('disables per-metric reset when there is no stored override', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: 'Reset to defaults' })).toBeDisabled();
  });

  it('shows the default under a field that differs', () => {
    renderPanel({ resolved: { ...connections, warningZScore: 2.5 } });
    expect(screen.getByText('default 2')).toBeInTheDocument();
  });

  it('calls onOpenChange when the header is clicked', () => {
    const { props } = renderPanel({ open: false });
    fireEvent.click(screen.getByRole('button', { name: /connections/ }));
    expect(props.onOpenChange).toHaveBeenCalledWith(true);
  });
});
