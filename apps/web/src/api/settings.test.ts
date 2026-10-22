import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchApi } from './client';
import { settingsApi } from './settings';

vi.mock('./client', () => ({ fetchApi: vi.fn().mockResolvedValue({}) }));

describe('settingsApi anomaly detector thresholds', () => {
  beforeEach(() => {
    vi.mocked(fetchApi).mockClear();
  });

  it('fetches detector thresholds', async () => {
    await settingsApi.getAnomalyDetectors();
    expect(fetchApi).toHaveBeenCalledWith('/settings/anomaly/detectors');
  });

  it('patches detector thresholds with the given map', async () => {
    await settingsApi.updateAnomalyDetectors({ connections: { warningZScore: 3 } });
    expect(fetchApi).toHaveBeenCalledWith('/settings/anomaly/detectors', {
      method: 'PATCH',
      body: JSON.stringify({ connections: { warningZScore: 3 } }),
    });
  });

  it('resets one metric', async () => {
    await settingsApi.resetAnomalyDetector('evicted_keys');
    expect(fetchApi).toHaveBeenCalledWith('/settings/anomaly/detectors/evicted_keys', {
      method: 'DELETE',
    });
  });

  it('resets all metrics', async () => {
    await settingsApi.resetAllAnomalyDetectors();
    expect(fetchApi).toHaveBeenCalledWith('/settings/anomaly/detectors/reset', {
      method: 'POST',
    });
  });
});
