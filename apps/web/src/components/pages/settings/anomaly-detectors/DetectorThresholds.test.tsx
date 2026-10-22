import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  ANOMALY_DETECTOR_METRICS,
  type AnomalyDetectorConfigEntry,
  type AnomalyDetectorSettingsResponse,
} from '@betterdb/shared';
import { renderWithQuery } from '../../../../test/test-utils';
import { DetectorThresholds } from './DetectorThresholds';

const { api, licenseState } = vi.hoisted(() => ({
  api: {
    getAnomalyDetectors: vi.fn(),
    updateAnomalyDetectors: vi.fn(),
    resetAnomalyDetector: vi.fn(),
    resetAllAnomalyDetectors: vi.fn(),
  },
  licenseState: { licensed: true },
}));

vi.mock('../../../../api/settings', () => ({ settingsApi: api }));
vi.mock('../../../../hooks/useLicense', () => ({
  useLicense: () => ({
    tier: licenseState.licensed ? 'pro' : 'community',
    license: null,
    hasFeature: () => licenseState.licensed,
  }),
}));

const base: AnomalyDetectorConfigEntry = {
  warningZScore: 2,
  criticalZScore: 3,
  consecutiveRequired: 3,
  cooldownMs: 60000,
};

function response(
  overrides: AnomalyDetectorSettingsResponse['overrides'] = {},
): AnomalyDetectorSettingsResponse {
  const all = Object.fromEntries(ANOMALY_DETECTOR_METRICS.map((m) => [m, base])) as
    AnomalyDetectorSettingsResponse['defaults'];
  return { defaults: all, overrides, resolved: all };
}

function renderAt(url: string) {
  return renderWithQuery(
    <MemoryRouter initialEntries={[url]}>
      <DetectorThresholds />
    </MemoryRouter>,
  );
}

describe('DetectorThresholds', () => {
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    licenseState.licensed = true;
    scrollIntoView.mockReset();
    Element.prototype.scrollIntoView = scrollIntoView;
    api.getAnomalyDetectors.mockReset().mockResolvedValue(response());
    api.resetAllAnomalyDetectors.mockReset().mockResolvedValue({ message: 'ok', config: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the Pro notice without a licence and does not fetch', () => {
    licenseState.licensed = false;
    renderAt('/settings?section=anomaly');
    expect(screen.getByText('Pro feature')).toBeInTheDocument();
    expect(api.getAnomalyDetectors).not.toHaveBeenCalled();
  });

  it('renders one panel per metric', async () => {
    renderAt('/settings?section=anomaly');
    for (const metric of ANOMALY_DETECTOR_METRICS) {
      expect(await screen.findByText(metric)).toBeInTheDocument();
    }
  });

  it('opens and scrolls to the deep-linked metric once data loads', async () => {
    let resolve!: (value: AnomalyDetectorSettingsResponse) => void;
    api.getAnomalyDetectors.mockReturnValue(new Promise((r) => (resolve = r)));
    renderAt('/settings?section=anomaly&metric=evicted_keys');
    expect(scrollIntoView).not.toHaveBeenCalled();
    resolve(response());
    expect(await screen.findByLabelText('Warning z-score')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Warning z-score')).toHaveLength(1);
    expect(document.getElementById('detector-evicted_keys')).toHaveAttribute('data-state', 'open');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
  });

  it('keeps every panel collapsed for an unknown metric', async () => {
    renderAt('/settings?section=anomaly&metric=foo');
    expect(await screen.findByText('connections')).toBeInTheDocument();
    expect(screen.queryByLabelText('Warning z-score')).not.toBeInTheDocument();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('resets all after confirmation', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    api.getAnomalyDetectors.mockResolvedValue(response({ connections: { warningZScore: 2.5 } }));
    renderAt('/settings?section=anomaly');
    const button = await screen.findByRole('button', { name: 'Reset all to defaults' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(api.resetAllAnomalyDetectors).toHaveBeenCalled());
  });

  it('shows every metric on defaults after reset all, before the refetch returns', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const stored = response({ connections: { warningZScore: 2.5 } });
    stored.resolved = { ...stored.resolved, connections: { ...base, warningZScore: 2.5 } };
    api.getAnomalyDetectors.mockResolvedValue(stored);
    api.resetAllAnomalyDetectors.mockResolvedValue({ message: 'ok', config: {} });
    const { queryClient } = renderAt('/settings?section=anomaly');
    expect(await screen.findByText('z 2.5 / 3')).toBeInTheDocument();
    api.getAnomalyDetectors.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Reset all to defaults' }));
    await waitFor(() => expect(screen.queryByText('z 2.5 / 3')).not.toBeInTheDocument());
    const cached = queryClient.getQueryData<AnomalyDetectorSettingsResponse>(['anomaly-detectors']);
    expect(cached?.overrides).toEqual({});
    expect(cached?.resolved).toEqual(cached?.defaults);
  });

  it('does not reset all when confirmation is declined', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    api.getAnomalyDetectors.mockResolvedValue(response({ connections: { warningZScore: 2.5 } }));
    renderAt('/settings?section=anomaly');
    const button = await screen.findByRole('button', { name: 'Reset all to defaults' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(api.resetAllAnomalyDetectors).not.toHaveBeenCalled();
  });

  it('disables reset all when nothing is overridden', async () => {
    renderAt('/settings?section=anomaly');
    await screen.findByText('connections');
    expect(screen.getByRole('button', { name: 'Reset all to defaults' })).toBeDisabled();
  });

  it('shows a load error inline', async () => {
    api.getAnomalyDetectors.mockRejectedValue(new Error('boom'));
    renderAt('/settings?section=anomaly');
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
  });

  it('shows a saved panel as saved before the refetch returns', async () => {
    api.updateAnomalyDetectors.mockResolvedValue({ message: 'ok', config: {} });
    renderAt('/settings?section=anomaly&metric=connections');
    const input = (await screen.findByLabelText('Warning z-score')) as HTMLInputElement;
    api.getAnomalyDetectors.mockReturnValue(new Promise(() => {}));
    fireEvent.change(input, { target: { value: '2.5' } });
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateAnomalyDetectors).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Unsaved')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText('z 2.5 / 3')).toBeInTheDocument();
  });

  it('keeps untouched overrides in the cache after a partial save', async () => {
    const stored = response({ connections: { warningZScore: 2.5 } });
    stored.resolved = { ...stored.resolved, connections: { ...base, warningZScore: 2.5 } };
    api.getAnomalyDetectors.mockResolvedValue(stored);
    api.updateAnomalyDetectors.mockResolvedValue({ message: 'ok', config: {} });
    const { queryClient } = renderAt('/settings?section=anomaly&metric=connections');
    const input = (await screen.findByLabelText('Cooldown (seconds)')) as HTMLInputElement;
    api.getAnomalyDetectors.mockReturnValue(new Promise(() => {}));
    fireEvent.change(input, { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByText('Unsaved')).not.toBeInTheDocument());
    const cached = queryClient.getQueryData<AnomalyDetectorSettingsResponse>(['anomaly-detectors']);
    expect(cached?.overrides.connections).toEqual({ warningZScore: 2.5, cooldownMs: 90000 });
    expect(cached?.resolved.connections).toEqual({ ...base, warningZScore: 2.5, cooldownMs: 90000 });
    expect(screen.getByText('z 2.5 / 3')).toBeInTheDocument();
  });

  it('keeps the panels and their unsaved edits when a refetch fails', async () => {
    const { queryClient } = renderAt('/settings?section=anomaly&metric=connections');
    const input = (await screen.findByLabelText('Warning z-score')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2.5' } });
    api.getAnomalyDetectors.mockRejectedValue(new Error('refetch failed'));
    await queryClient.refetchQueries({ queryKey: ['anomaly-detectors'] });
    expect(await screen.findByText(/refetch failed/)).toBeInTheDocument();
    expect((screen.getByLabelText('Warning z-score') as HTMLInputElement).value).toBe('2.5');
  });
});
