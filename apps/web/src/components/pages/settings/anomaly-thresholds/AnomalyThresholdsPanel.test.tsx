import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type {
  AnomalyDetectorConfigEntry,
  AnomalyDetectorMetric,
  AnomalyDetectorSettingsResponse,
} from '@betterdb/shared';
import { renderWithQuery } from '../../../../test/test-utils';
import { AnomalyThresholdsPanel } from './AnomalyThresholdsPanel';

const { api, licenseState } = vi.hoisted(() => {
  return {
    api: {
      get: vi.fn(),
      update: vi.fn(),
      clearMetric: vi.fn(),
      resetAll: vi.fn(),
    },
    licenseState: { licensed: true },
  };
});

vi.mock('../../../../api/anomaly-detectors', () => ({ anomalyDetectorsApi: api }));
vi.mock('../../../../hooks/useLicense', () => ({
  useLicense: () => ({ hasFeature: () => licenseState.licensed }),
}));

const Z: AnomalyDetectorConfigEntry = {
  warningZScore: 2,
  criticalZScore: 3,
  consecutiveRequired: 3,
  cooldownMs: 60_000,
};

const DEFAULTS: Record<AnomalyDetectorMetric, AnomalyDetectorConfigEntry> = {
  connections: { ...Z },
  ops_per_sec: { ...Z },
  memory_used: { ...Z, warningZScore: 2.5, criticalZScore: 3.5 },
  input_kbps: { ...Z },
  output_kbps: { ...Z },
  slowlog_last_id: {
    ...Z,
    warningZScore: 1.5,
    criticalZScore: 2.5,
    consecutiveRequired: 1,
    cooldownMs: 30_000,
  },
  acl_denied: {
    ...Z,
    warningZScore: 1.5,
    criticalZScore: 2.5,
    warningAbsolute: 10,
    criticalAbsolute: 50,
    consecutiveRequired: 2,
    cooldownMs: 30_000,
  },
  evicted_keys: { ...Z, consecutiveRequired: 2, cooldownMs: 30_000 },
  blocked_clients: { ...Z },
  keyspace_misses: { ...Z },
  fragmentation_ratio: {
    ...Z,
    warningAbsolute: 1.5,
    criticalAbsolute: 2.0,
    consecutiveRequired: 5,
    cooldownMs: 120_000,
  },
};

const NO_OVERRIDES: AnomalyDetectorSettingsResponse = {
  defaults: DEFAULTS,
  overrides: {},
  resolved: DEFAULTS,
};

const WITH_ACL_OVERRIDE: AnomalyDetectorSettingsResponse = {
  defaults: DEFAULTS,
  overrides: { acl_denied: { warningZScore: 1.8 } },
  resolved: { ...DEFAULTS, acl_denied: { ...DEFAULTS.acl_denied, warningZScore: 1.8 } },
};

function input(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

function type(label: string, value: string): void {
  fireEvent.change(input(label), { target: { value } });
}

async function renderLoaded(data = WITH_ACL_OVERRIDE): Promise<void> {
  api.get.mockResolvedValue(data);
  renderWithQuery(<AnomalyThresholdsPanel />);
  await screen.findByLabelText('Connections Warning z-score');
}

const saveButton = () => screen.getByRole('button', { name: 'Save thresholds' });

describe('AnomalyThresholdsPanel', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) {
      fn.mockReset();
    }
    licenseState.licensed = true;
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the license note and makes no request when unlicensed', () => {
    licenseState.licensed = false;
    renderWithQuery(<AnomalyThresholdsPanel />);
    expect(screen.getByText(/available on Pro and Enterprise/)).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('renders a row per metric with resolved values and the override badge', async () => {
    await renderLoaded();
    expect(screen.getAllByRole('row')).toHaveLength(12);
    expect(input('Connections Warning z-score')).toHaveValue(2);
    expect(input('ACL denials Warning z-score')).toHaveValue(1.8);
    expect(screen.getAllByText('Overridden')).toHaveLength(1);
  });

  it('saves only the changed field, then refetches and confirms', async () => {
    await renderLoaded();
    api.update.mockResolvedValue({ message: 'Detector thresholds updated', config: {} });
    type('Connections Warning z-score', '2.5');
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(api.update).toHaveBeenCalledTimes(1);
    });
    expect(api.update).toHaveBeenCalledWith({ connections: { warningZScore: 2.5 } });
    await waitFor(() => {
      expect(api.get).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText('Detector thresholds updated')).toBeInTheDocument();
  });

  it('blocks save while a client-side rule is violated', async () => {
    await renderLoaded();
    type('Connections Critical z-score', '1.5');
    expect(screen.getByText('Must be greater than the warning z-score')).toBeInTheDocument();
    expect(input('Connections Critical z-score')).toHaveAttribute('aria-invalid', 'true');
    expect(saveButton()).toBeDisabled();
    fireEvent.click(saveButton());
    expect(api.update).not.toHaveBeenCalled();
  });

  it('shows a server error and keeps the draft', async () => {
    await renderLoaded();
    api.update.mockRejectedValue(
      new Error('acl_denied: warningAbsolute (100) must be less than criticalAbsolute (50)'),
    );
    type('ACL denials Warning absolute', '40');
    fireEvent.click(saveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/warningAbsolute \(100\)/);
    expect(input('ACL denials Warning absolute')).toHaveValue(40);
  });

  it('resets one metric and disables Reset where there is no override', async () => {
    await renderLoaded();
    expect(screen.getByRole('button', { name: 'Reset Connections to defaults' })).toBeDisabled();
    api.clearMetric.mockResolvedValue({ message: 'Reset acl_denied', config: {} });
    fireEvent.click(screen.getByRole('button', { name: 'Reset ACL denials to defaults' }));
    await waitFor(() => {
      expect(api.clearMetric).toHaveBeenCalledWith('acl_denied');
    });
  });

  it('keeps unsaved edits to other metrics when one metric is reset', async () => {
    await renderLoaded();
    api.clearMetric.mockResolvedValue({ message: 'Reset acl_denied', config: {} });
    api.get.mockResolvedValue(NO_OVERRIDES);
    type('Connections Warning z-score', '2.5');
    fireEvent.click(screen.getByRole('button', { name: 'Reset ACL denials to defaults' }));
    await waitFor(() => {
      expect(input('ACL denials Warning z-score')).toHaveValue(1.5);
    });
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(input('Connections Warning z-score')).toHaveValue(2.5);
  });

  it('asks before resetting everything', async () => {
    await renderLoaded();
    api.resetAll.mockResolvedValue({ message: 'All reset' });
    const resetAll = screen.getByRole('button', { name: 'Reset all' });

    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(resetAll);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(api.resetAll).not.toHaveBeenCalled();

    fireEvent.click(resetAll);
    await waitFor(() => {
      expect(api.resetAll).toHaveBeenCalledTimes(1);
    });
  });

  it('discards edits and disables Save again', async () => {
    await renderLoaded();
    type('Connections Warning z-score', '2.5');
    expect(saveButton()).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(input('Connections Warning z-score')).toHaveValue(2);
    expect(saveButton()).toBeDisabled();
  });

  it('shows a disabled absolute as empty with an "off" placeholder', async () => {
    await renderLoaded();
    const field = input('Connections Warning absolute');
    expect(field).toHaveValue(null);
    expect(field.value).toBe('');
    expect(field).toHaveAttribute('placeholder', 'off');
  });
});
