import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getSettings, updateSettings, connection } = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  connection: { id: 'c1' },
}));

vi.mock('../../../../hooks/useConnection', () => ({
  useConnection: () => ({ currentConnection: { id: connection.id } }),
}));
vi.mock('../../../../api/kv-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../api/kv-cache')>();
  return { ...actual, kvCacheApi: { getSettings, updateSettings } };
});

import { kvCacheKeys } from '../../../../api/kv-cache';
import { KvCacheSettingsSheet } from '../KvCacheSettingsSheet';

const SETTINGS = { hitRateAlertEnabled: true, hitRateThreshold: 0.2, evictionAlertEnabled: true };

describe('KvCacheSettingsSheet', () => {
  beforeEach(() => {
    connection.id = 'c1';
    getSettings.mockReset().mockResolvedValue(SETTINGS);
    updateSettings.mockReset();
  });

  it('sends a second save only after the first one finishes', async () => {
    let finishFirst: (value: unknown) => void = () => undefined;
    updateSettings
      .mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)))
      .mockResolvedValue(SETTINGS);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <KvCacheSettingsSheet />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Alert settings' }));
    fireEvent.click(await screen.findByLabelText('Alert on low hit rate'));
    fireEvent.click(screen.getByLabelText('Alert on eviction risk'));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith({ hitRateAlertEnabled: false });
    finishFirst(SETTINGS);
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    expect(updateSettings).toHaveBeenLastCalledWith({ evictionAlertEnabled: false });
  });

  it('drops an unsaved threshold when the connection changes to one with the same threshold', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(kvCacheKeys.settings('c2'), SETTINGS);
    const tree = () => (
      <QueryClientProvider client={client}>
        <KvCacheSettingsSheet />
      </QueryClientProvider>
    );
    const { rerender } = render(tree());
    fireEvent.click(screen.getByRole('button', { name: 'Alert settings' }));
    const input = await screen.findByLabelText('Hit rate threshold');
    await waitFor(() => expect(input).toHaveValue(20));
    fireEvent.change(input, { target: { value: '35' } });
    connection.id = 'c2';
    rerender(tree());
    await waitFor(() => expect(screen.getByLabelText('Hit rate threshold')).toHaveValue(20));
    fireEvent.blur(screen.getByLabelText('Hit rate threshold'));
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
