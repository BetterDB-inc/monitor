import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { createEngine } = vi.hoisted(() => ({ createEngine: vi.fn() }));

vi.mock('../../../../hooks/useConnection', () => ({
  useConnection: () => ({ currentConnection: { id: 'c1' } }),
}));
vi.mock('../../../../api/kv-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../api/kv-cache')>();
  return { ...actual, kvCacheApi: { createEngine } };
});

import { LinkEngineDialog } from '../LinkEngineDialog';

function renderDialog(onOpenChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LinkEngineDialog open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return onOpenChange;
}

describe('LinkEngineDialog', () => {
  beforeEach(() => {
    createEngine.mockReset();
  });

  it('shows the server message and stays open when the scrape test fails', async () => {
    createEngine.mockImplementation(async () => {
      throw new Error('Test scrape failed: HTTP 401');
    });
    const onOpenChange = renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'vllm-1' } });
    fireEvent.change(screen.getByLabelText('Metrics URL'), {
      target: { value: 'http://vllm:8000/metrics' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Test scrape failed: HTTP 401')).toBeInTheDocument();
    expect(createEngine).toHaveBeenCalledWith({
      name: 'vllm-1',
      source: 'scrape',
      scrapeUrl: 'http://vllm:8000/metrics',
    });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByLabelText('Metrics URL')).toBeInTheDocument();
  });

  it('shows the returned engine id inside the collector snippet for OTLP', async () => {
    createEngine.mockResolvedValue({ id: 'e1', otlpEngineId: 'lmc-abc123', source: 'otlp' });
    renderDialog();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'OTLP' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'pushed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(createEngine).toHaveBeenCalledWith({ name: 'pushed', source: 'otlp' }),
    );
    const pre = await screen.findByTestId('collector-snippet');
    expect(pre.textContent).toContain('value: lmc-abc123');
    expect(pre.textContent).toContain('http://localhost:3001/v1/external/metrics');
  });

  it('keeps a separate name for each tab', async () => {
    createEngine.mockResolvedValue({ id: 'e1', otlpEngineId: 'lmc-abc123', source: 'otlp' });
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'scraped' } });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'OTLP' }));
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'pushed' } });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Scrape' }));
    expect(screen.getByLabelText('Name')).toHaveValue('scraped');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'OTLP' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(createEngine).toHaveBeenCalledWith({ name: 'pushed', source: 'otlp' }),
    );
  });
});
