import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OtlpPushTab, buildCollectorSnippet } from './OtlpPushTab';

const fetchApi = vi.fn();
vi.mock('../../api/client', () => ({
  fetchApi: (...args: unknown[]) => fetchApi(...args),
  apiOrigin: () => 'https://monitor.example.com',
}));

describe('buildCollectorSnippet', () => {
  it('points the redis receiver at the instance and the exporter at the external endpoint', () => {
    const snippet = buildCollectorSnippet('cache.internal', 6380, 'https://monitor.example.com');
    expect(snippet).toContain('endpoint: cache.internal:6380');
    expect(snippet).toContain('server.address:\n        enabled: true');
    expect(snippet).toContain('server.port:\n        enabled: true');
    expect(snippet).toContain('metrics_endpoint: https://monitor.example.com/v1/external/metrics');
    expect(snippet).toContain('Authorization: "Bearer ${env:BETTERDB_OTEL_INGEST_TOKEN}"');
    expect(snippet).not.toMatch(/^\s+endpoint: https/m);
  });
});

describe('OtlpPushTab', () => {
  beforeEach(() => {
    fetchApi.mockReset();
  });

  it('creates an external connection with only name, host and port', async () => {
    fetchApi.mockResolvedValue({ id: 'new' });
    const onCreated = vi.fn().mockResolvedValue(undefined);
    render(<OtlpPushTab isFirstConnection={true} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Pushed' } });
    fireEvent.change(screen.getByLabelText('Host *'), { target: { value: 'cache.internal' } });
    fireEvent.change(screen.getByLabelText('Port *'), { target: { value: '6380' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add OTLP connection' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(fetchApi).toHaveBeenCalledWith('/connections', {
      method: 'POST',
      body: JSON.stringify({ name: 'Pushed', host: 'cache.internal', port: 6380, connectionType: 'external', setAsDefault: true }),
    });
  });

  it('shows the API error', async () => {
    fetchApi.mockRejectedValue(new Error('A connection for cache.internal:6380 already exists'));
    render(<OtlpPushTab isFirstConnection={false} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Pushed' } });
    fireEvent.change(screen.getByLabelText('Host *'), { target: { value: 'cache.internal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add OTLP connection' }));
    expect(await screen.findByText('A connection for cache.internal:6380 already exists')).toBeTruthy();
  });
});
