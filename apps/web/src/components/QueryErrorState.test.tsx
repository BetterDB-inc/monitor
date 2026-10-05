import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApiError, ExternalConnectionUnsupportedError } from '../api/client';
import { QueryErrorState, findExternalUnsupportedError } from './QueryErrorState';

const UNSUPPORTED_COPY =
  'Not available for OTLP-ingested connections — this view needs a live connection.';

describe('QueryErrorState', () => {
  it('renders the live connection empty state for an unsupported error', () => {
    render(
      <QueryErrorState
        error={new ExternalConnectionUnsupportedError('getSlowLog')}
        fallback={<p>generic failure</p>}
      />,
    );

    expect(screen.getByText('Live connection required')).toBeTruthy();
    expect(screen.getByText(UNSUPPORTED_COPY)).toBeTruthy();
    expect(screen.queryByText('generic failure')).toBeNull();
  });

  it('renders the fallback for any other error', () => {
    render(<QueryErrorState error={new ApiError('boom', 500)} fallback={<p>generic failure</p>} />);

    expect(screen.getByText('generic failure')).toBeTruthy();
    expect(screen.queryByText(UNSUPPORTED_COPY)).toBeNull();
  });

  it('renders nothing without an error or fallback', () => {
    const { container } = render(<QueryErrorState error={null} />);

    expect(container.innerHTML).toBe('');
  });
});

describe('findExternalUnsupportedError', () => {
  it('returns the first unsupported error and ignores others', () => {
    const unsupported = new ExternalConnectionUnsupportedError('getClients');

    expect(
      findExternalUnsupportedError(null, new ApiError('boom', 500), unsupported, undefined),
    ).toBe(unsupported);
  });

  it('returns null when no error is an unsupported error', () => {
    expect(findExternalUnsupportedError(null, new ApiError('boom', 500))).toBeNull();
  });
});
