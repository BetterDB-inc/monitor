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
    expect(updateSettings).toHaveBeenCalledWith({ hitRateAlertEnabled: false }, 'c1');
    finishFirst(SETTINGS);
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    expect(updateSettings).toHaveBeenLastCalledWith({ evictionAlertEnabled: false }, 'c1');
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

  function renderOpenSheet() {
    updateSettings.mockResolvedValue(SETTINGS);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <KvCacheSettingsSheet />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Alert settings' }));
  }

  it('saves the threshold on Enter', async () => {
    renderOpenSheet();
    const input = await screen.findByLabelText('Hit rate threshold');
    await waitFor(() => expect(input).toHaveValue(20));
    fireEvent.change(input, { target: { value: '35' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ hitRateThreshold: 0.35 }, 'c1'),
    );
    fireEvent.blur(input);
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });

  it('sends a threshold changed back to the saved value while the first save is in flight', async () => {
    let finishFirst: (value: unknown) => void = () => undefined;
    renderOpenSheet();
    updateSettings
      .mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)))
      .mockResolvedValue(SETTINGS);
    const input = await screen.findByLabelText('Hit rate threshold');
    await waitFor(() => expect(input).toHaveValue(20));
    fireEvent.change(input, { target: { value: '50' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: '20' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    finishFirst({ ...SETTINGS, hitRateThreshold: 0.5 });
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    expect(updateSettings).toHaveBeenNthCalledWith(1, { hitRateThreshold: 0.5 }, 'c1');
    expect(updateSettings).toHaveBeenNthCalledWith(2, { hitRateThreshold: 0.2 }, 'c1');
    await waitFor(() => expect(input).toHaveValue(20));
  });

  it('retries a threshold save after it failed', async () => {
    renderOpenSheet();
    updateSettings.mockRejectedValueOnce(new Error('boom'));
    const input = await screen.findByLabelText('Hit rate threshold');
    await waitFor(() => expect(input).toHaveValue(20));
    fireEvent.change(input, { target: { value: '35' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Save failed')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    expect(updateSettings).toHaveBeenLastCalledWith({ hitRateThreshold: 0.35 }, 'c1');
  });

  it('saves an edited threshold when the sheet is closed with Escape', async () => {
    renderOpenSheet();
    const input = await screen.findByLabelText('Hit rate threshold');
    await waitFor(() => expect(input).toHaveValue(20));
    fireEvent.change(input, { target: { value: '40' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ hitRateThreshold: 0.4 }, 'c1'),
    );
  });

  it('keeps a queued save on the connection it was made for', async () => {
    let finishFirst: (value: unknown) => void = () => undefined;
    updateSettings
      .mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)))
      .mockResolvedValue(SETTINGS);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(kvCacheKeys.settings('c2'), SETTINGS);
    const tree = () => (
      <QueryClientProvider client={client}>
        <KvCacheSettingsSheet />
      </QueryClientProvider>
    );
    const { rerender } = render(tree());
    fireEvent.click(screen.getByRole('button', { name: 'Alert settings' }));
    fireEvent.click(await screen.findByLabelText('Alert on low hit rate'));
    fireEvent.click(screen.getByLabelText('Alert on eviction risk'));
    connection.id = 'c2';
    rerender(tree());
    finishFirst(SETTINGS);
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    expect(updateSettings).toHaveBeenLastCalledWith({ evictionAlertEnabled: false }, 'c1');
  });

  it('leaves a non-whole saved threshold alone when the sheet closes unedited', async () => {
    getSettings.mockResolvedValue({ ...SETTINGS, hitRateThreshold: 0.125 });
    renderOpenSheet();
    const input = await screen.findByLabelText('Hit rate threshold');
    await waitFor(() => expect(input).toHaveValue(13));
    fireEvent.blur(input);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await new Promise((r) => setTimeout(r, 20));
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('toggles a switch back when it is clicked twice before the first save lands', async () => {
    let finishFirst: (value: unknown) => void = () => undefined;
    updateSettings
      .mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)))
      .mockResolvedValue(SETTINGS);
    renderOpenSheet();
    const toggle = await screen.findByLabelText('Alert on low hit rate');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    finishFirst({ ...SETTINGS, hitRateAlertEnabled: false });
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    expect(updateSettings).toHaveBeenNthCalledWith(1, { hitRateAlertEnabled: false }, 'c1');
    expect(updateSettings).toHaveBeenNthCalledWith(2, { hitRateAlertEnabled: true }, 'c1');
  });

  it('puts a switch back when its save fails', async () => {
    renderOpenSheet();
    let fail: (error: Error) => void = () => undefined;
    updateSettings.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));
    const toggle = await screen.findByLabelText('Alert on eviction risk');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    fail(new Error('boom'));
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  });

  it('reports a save that fails after the sheet closed', async () => {
    renderOpenSheet();
    updateSettings.mockRejectedValueOnce(new Error('boom'));
    const input = await screen.findByLabelText('Hit rate threshold');
    await waitFor(() => expect(input).toHaveValue(20));
    fireEvent.change(input, { target: { value: '40' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Alert settings not saved: boom')).toBeInTheDocument();
  });

  it('shows a failed save only on the connection it targeted', async () => {
    updateSettings.mockRejectedValueOnce(new Error('boom'));
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
    fireEvent.change(input, { target: { value: '40' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(await screen.findByText('Alert settings not saved: boom')).toBeInTheDocument();
    connection.id = 'c2';
    rerender(tree());
    expect(screen.queryByText(/Alert settings not saved/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Alert settings' }));
    await screen.findByLabelText('Hit rate threshold');
    expect(screen.queryByText('Save failed')).toBeNull();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    connection.id = 'c1';
    rerender(tree());
    expect(screen.getByText('Alert settings not saved: boom')).toBeInTheDocument();
  });
});
