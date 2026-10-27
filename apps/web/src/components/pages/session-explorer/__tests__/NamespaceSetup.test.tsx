import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NamespaceSetup } from '../NamespaceSetup';
import { sessionExplorerApi } from '../../../../api/session-explorer';
import { ApiError } from '../../../../api/client';
import { parsedKey } from './fixtures';

vi.mock('../../../../api/session-explorer', () => ({
  sessionExplorerApi: {
    preview: vi.fn(),
    createNamespace: vi.fn(),
    updateNamespace: vi.fn(),
  },
}));

const api = vi.mocked(sessionExplorerApi);

const fill = () => {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chats' } });
  fireEvent.change(screen.getByLabelText('Key pattern'), { target: { value: 'chat:*' } });
};

describe('NamespaceSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reveals the schema fields only for the custom preset', () => {
    render(<NamespaceSetup onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByLabelText('Role field')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Preset'), { target: { value: 'custom' } });
    expect(screen.getByLabelText('Role field')).toBeInTheDocument();
    expect(screen.getByLabelText('Content field')).toBeInTheDocument();
    expect(screen.getByLabelText('Value type')).toBeInTheDocument();
  });

  it('previews against a sampled key and renders the returned view', async () => {
    api.preview.mockResolvedValue({ sampleKey: 'chat:1', view: parsedKey(), exhausted: true, failedNodes: 0, touchesKeys: false });
    render(<NamespaceSetup onSaved={vi.fn()} onCancel={vi.fn()} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByText('Where should I stay?')).toBeInTheDocument());
    expect(api.preview).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Chats', pattern: 'chat:*', preset: 'langchain-community' }),
    );
    expect(api.createNamespace).not.toHaveBeenCalled();
  });

  it('says part of the cluster was not scanned even when a key matched', async () => {
    api.preview.mockResolvedValue({
      sampleKey: 'chat:1',
      view: parsedKey(),
      exhausted: false,
      failedNodes: 1,
      touchesKeys: false,
    });
    render(<NamespaceSetup onSaved={vi.fn()} onCancel={vi.fn()} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByText('Where should I stay?')).toBeInTheDocument());
    expect(screen.getByText(/1 node could not be scanned/)).toBeInTheDocument();
  });

  it('says when reading the sample reset its access time', async () => {
    api.preview.mockResolvedValue({
      sampleKey: 'chat:1',
      view: parsedKey(),
      exhausted: false,
      failedNodes: 0,
      touchesKeys: true,
    });
    render(<NamespaceSetup onSaved={vi.fn()} onCancel={vi.fn()} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByText(/reset the idle time/i)).toBeInTheDocument());
  });

  it('sends the custom schema with the preview', async () => {
    api.preview.mockResolvedValue({ sampleKey: null, view: null, exhausted: true, failedNodes: 0, touchesKeys: false });
    render(<NamespaceSetup onSaved={vi.fn()} onCancel={vi.fn()} />);
    fill();
    fireEvent.change(screen.getByLabelText('Preset'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('Role field'), { target: { value: 'who' } });
    fireEvent.change(screen.getByLabelText('Content field'), { target: { value: 'text' } });
    fireEvent.change(screen.getByLabelText('Session id template'), {
      target: { value: ' chat:{session} ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByText(/No key matched/)).toBeInTheDocument());
    expect(api.preview.mock.calls[0][0].customSchema).toMatchObject({
      sessionTemplate: 'chat:{session}',
      valueType: 'list',
      messages: { from: 'items' },
      fields: { role: 'who', content: 'text' },
    });
  });

  it('says part of the cluster was not searched when a node failed', async () => {
    api.preview.mockResolvedValue({ sampleKey: null, view: null, exhausted: false, failedNodes: 1, touchesKeys: false });
    render(<NamespaceSetup onSaved={vi.fn()} onCancel={vi.fn()} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() =>
      expect(
        screen.getByText(
          'No matching key found, but part of the cluster could not be scanned.',
        ),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByText('No matching key in the first 10,000 keys scanned on each node.'),
    ).not.toBeInTheDocument();
  });

  it('says the preview search was partial when the scan budget ran out', async () => {
    api.preview.mockResolvedValue({ sampleKey: null, view: null, exhausted: false, failedNodes: 0, touchesKeys: false });
    render(<NamespaceSetup onSaved={vi.fn()} onCancel={vi.fn()} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() =>
      expect(
        screen.getByText('No matching key in the first 10,000 keys scanned on each node.'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('No key matched this pattern.')).not.toBeInTheDocument();
  });

  it('blames an unreachable node rather than expiry when the sample read failed', async () => {
    api.preview.mockResolvedValue({ sampleKey: 'chat:1', view: null, exhausted: false, failedNodes: 1, touchesKeys: false });
    render(<NamespaceSetup onSaved={vi.fn()} onCancel={vi.fn()} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() =>
      expect(
        screen.getByText('Matched chat:1, but part of the cluster could not be read.'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/may have expired/)).not.toBeInTheDocument();
  });

  it('says the sampled key could not be read instead of reporting no match', async () => {
    api.preview.mockResolvedValue({ sampleKey: 'chat:1', view: null, exhausted: true, failedNodes: 0, touchesKeys: false });
    render(<NamespaceSetup onSaved={vi.fn()} onCancel={vi.fn()} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() =>
      expect(
        screen.getByText('Matched chat:1, but it could not be read. It may have expired.'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('No key matched this pattern.')).not.toBeInTheDocument();
  });

  it('shows server validation errors inline', async () => {
    api.createNamespace.mockRejectedValue(
      new ApiError('Invalid namespace', 400, {
        message: 'Invalid namespace',
        errors: ['Pattern must include a literal prefix'],
      }),
    );
    const onSaved = vi.fn();
    render(<NamespaceSetup onSaved={onSaved} onCancel={vi.fn()} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByText('Pattern must include a literal prefix')).toBeInTheDocument(),
    );
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('suggests a session template with the session placeholder', () => {
    render(<NamespaceSetup onSaved={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Preset'), { target: { value: 'custom' } });
    expect(screen.getByLabelText('Session id template')).toHaveAttribute(
      'placeholder',
      'chat:{session}',
    );
  });

  it('clears an earlier preview when the inputs change', async () => {
    api.preview.mockResolvedValue({ sampleKey: 'chat:1', view: parsedKey(), exhausted: true, failedNodes: 0, touchesKeys: false });
    render(<NamespaceSetup onSaved={vi.fn()} onCancel={vi.fn()} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByText('Where should I stay?')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Key pattern'), { target: { value: 'other:*' } });
    expect(screen.queryByText('Where should I stay?')).not.toBeInTheDocument();
  });

  it('clears an earlier preview when a later preview fails', async () => {
    api.preview.mockResolvedValueOnce({ sampleKey: 'chat:1', view: parsedKey(), exhausted: true, failedNodes: 0, touchesKeys: false });
    api.preview.mockRejectedValueOnce(
      new ApiError('Invalid namespace', 400, { message: 'Invalid namespace', errors: ['Bad template'] }),
    );
    render(<NamespaceSetup onSaved={vi.fn()} onCancel={vi.fn()} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByText('Where should I stay?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByText('Bad template')).toBeInTheDocument());
    expect(screen.queryByText('Where should I stay?')).not.toBeInTheDocument();
  });

  it('saves a new namespace and reports it', async () => {
    const saved = { id: 'ns-1' };
    api.createNamespace.mockResolvedValue(saved as never);
    const onSaved = vi.fn();
    render(<NamespaceSetup onSaved={onSaved} onCancel={vi.fn()} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
  });
});
