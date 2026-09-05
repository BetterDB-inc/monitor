import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { InviteLinkDialog } from './InviteLinkDialog';

const URL = 'http://localhost/invite/tok';

describe('InviteLinkDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows Copied when the clipboard write succeeds', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    render(
      <InviteLinkDialog
        url={URL}
        onClose={() => {
          return undefined;
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(screen.queryByText(/Copy failed/)).toBeNull();
  });

  it('falls back to manual selection when navigator.clipboard is undefined', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });
    render(
      <InviteLinkDialog
        url={URL}
        onClose={() => {
          return undefined;
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(
      await screen.findByText('Copy failed. Select the link and copy it manually.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
  });

  it('falls back to manual selection when the clipboard write rejects', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    render(
      <InviteLinkDialog
        url={URL}
        onClose={() => {
          return undefined;
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(
      await screen.findByText('Copy failed. Select the link and copy it manually.'),
    ).toBeInTheDocument();
  });
});
