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
    api.preview.mockResolvedValue({ sampleKey: 'chat:1', view: parsedKey(), exhausted: true });
    render(<NamespaceSetup onSaved={vi.fn()} onCancel={vi.fn()} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByText('Where should I stay?')).toBeInTheDocument());
    expect(api.preview).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Chats', pattern: 'chat:*', preset: 'langchain-community' }),
    );
    expect(api.createNamespace).not.toHaveBeenCalled();
  });

  it('sends the custom schema with the preview', async () => {
    api.preview.mockResolvedValue({ sampleKey: null, view: null, exhausted: true });
    render(<NamespaceSetup onSaved={vi.fn()} onCancel={vi.fn()} />);
    fill();
    fireEvent.change(screen.getByLabelText('Preset'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('Role field'), { target: { value: 'who' } });
    fireEvent.change(screen.getByLabelText('Content field'), { target: { value: 'text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByText(/No key matched/)).toBeInTheDocument());
    expect(api.preview.mock.calls[0][0].customSchema).toMatchObject({
      valueType: 'list',
      messages: { from: 'items' },
      fields: { role: 'who', content: 'text' },
    });
  });

  it('says the preview search was partial when the scan budget ran out', async () => {
    api.preview.mockResolvedValue({ sampleKey: null, view: null, exhausted: false });
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
