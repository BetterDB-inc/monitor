import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { createEngine, conn } = vi.hoisted(() => ({ createEngine: vi.fn(), conn: { id: 'c1' } }));

vi.mock('../../../../hooks/useConnection', () => ({
  useConnection: () => ({ currentConnection: { id: conn.id } }),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        reopen
      </button>
      <LinkEngineDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function renderHarness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

const originalExecCommand = document.execCommand;

describe('LinkEngineDialog', () => {
  beforeEach(() => {
    createEngine.mockReset();
    conn.id = 'c1';
  });

  it('refreshes the connection a create started on after the selection changes', async () => {
    const pending = deferred<unknown>();
    createEngine.mockReturnValue(pending.promise);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const dialog = () => (
      <QueryClientProvider client={client}>
        <LinkEngineDialog open onOpenChange={vi.fn()} />
      </QueryClientProvider>
    );
    const { rerender } = render(dialog());
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'vllm-1' } });
    fireEvent.change(screen.getByLabelText('Metrics URL'), { target: { value: 'http://vllm:8000/metrics' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(createEngine).toHaveBeenCalled());
    conn.id = 'c2';
    rerender(dialog());
    await act(async () => {
      pending.resolve({ id: 'e1', source: 'scrape' });
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    const connections = invalidate.mock.calls.map(([filters]) => (filters?.queryKey as unknown[])[2]);
    expect(new Set(connections)).toEqual(new Set(['c1']));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.execCommand = originalExecCommand;
  });

  it('keeps the browser from filling a saved login password into the auth header', () => {
    renderDialog();
    const auth = screen.getByLabelText('Auth header (optional)');
    expect(auth).toHaveAttribute('type', 'password');
    expect(auth).toHaveAttribute('autocomplete', 'new-password');
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

  it('copies the collector snippet without navigator.clipboard', async () => {
    vi.stubGlobal('navigator', {});
    const execCommand = vi.fn().mockReturnValue(true);
    document.execCommand = execCommand;
    createEngine.mockResolvedValue({ id: 'e1', otlpEngineId: 'lmc-abc123', source: 'otlp' });
    renderDialog();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'OTLP' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'pushed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByTestId('collector-snippet');
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(execCommand).toHaveBeenCalledWith('copy');
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
    expect(pre.textContent).toContain("value: 'lmc-abc123'");
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

  it('keeps the tab and blocks a second create while one is in flight', async () => {
    const pending = deferred<unknown>();
    createEngine.mockReturnValue(pending.promise);
    const onOpenChange = renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'vllm-1' } });
    fireEvent.change(screen.getByLabelText('Metrics URL'), {
      target: { value: 'http://vllm:8000/metrics' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(createEngine).toHaveBeenCalledTimes(1));
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'OTLP' }));
    expect(screen.getByRole('tab', { name: 'Scrape' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await act(async () => {
      pending.resolve({ id: 'e1', source: 'scrape', otlpEngineId: null });
      await pending.promise;
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(createEngine).toHaveBeenCalledTimes(1);
  });

  it('ignores a scrape create that resolves after the dialog was closed and reopened', async () => {
    const pending = deferred<unknown>();
    createEngine.mockReturnValue(pending.promise);
    renderHarness();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'vllm-1' } });
    fireEvent.change(screen.getByLabelText('Metrics URL'), {
      target: { value: 'http://vllm:8000/metrics' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(createEngine).toHaveBeenCalled());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'reopen' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'second' } });
    await act(async () => {
      pending.resolve({ id: 'e1', source: 'scrape', otlpEngineId: null });
      await pending.promise;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('second');
  });

  it('does not jump to an old OTLP snippet after the dialog was closed and reopened', async () => {
    const pending = deferred<unknown>();
    createEngine.mockReturnValue(pending.promise);
    renderHarness();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'OTLP' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'pushed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(createEngine).toHaveBeenCalled());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'reopen' }));
    await screen.findByRole('dialog');
    await act(async () => {
      pending.resolve({ id: 'e1', source: 'otlp', otlpEngineId: 'lmc-old' });
      await pending.promise;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('collector-snippet')).toBeNull();
  });

  it('blocks a duplicate create after the dialog was closed and reopened mid-request', async () => {
    const pending = deferred<unknown>();
    createEngine.mockReturnValue(pending.promise);
    renderHarness();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'vllm-1' } });
    fireEvent.change(screen.getByLabelText('Metrics URL'), {
      target: { value: 'http://vllm:8000/metrics' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(createEngine).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'reopen' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'vllm-1' } });
    fireEvent.change(screen.getByLabelText('Metrics URL'), {
      target: { value: 'http://vllm:8000/metrics' },
    });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await act(async () => {
      pending.resolve({ id: 'e1', source: 'scrape', otlpEngineId: null });
      await pending.promise;
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(createEngine).toHaveBeenCalledTimes(1);
  });
});
