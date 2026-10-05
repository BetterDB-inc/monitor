import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VersionPendingCard } from './VersionPendingCard';

describe('VersionPendingCard', () => {
  it('tells a Redis user which attribute the first push needs', () => {
    render(
      <VersionPendingCard
        pending={{ product: 'redis', attribute: 'redis.version' }}
        retrying={false}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByTestId('version-pending-detail')).toHaveTextContent(
      'Monitor has not received a version for this instance from the collector yet. CVE matching starts on the first push that carries redis.version.',
    );
    expect(screen.queryByTestId('valkey-version-snippet')).not.toBeInTheDocument();
  });

  it('explains the Valkey compatibility version and shows the resource processor', () => {
    render(
      <VersionPendingCard
        pending={{ product: 'valkey', attribute: 'valkey.version' }}
        retrying={false}
        onRetry={vi.fn()}
      />,
    );

    const detail = screen.getByTestId('version-pending-detail');
    expect(detail).toHaveTextContent('redis_version 7.2.4');
    expect(detail).toHaveTextContent('valkey.version');
    const snippet = screen.getByTestId('valkey-version-snippet');
    expect(snippet).toHaveTextContent('key: valkey.version');
    expect(snippet).toHaveTextContent('key: db.system.name');
    expect(snippet).toHaveTextContent('processors: [resource/valkey]');
  });

  it('checks again on demand', () => {
    const onRetry = vi.fn();
    render(
      <VersionPendingCard
        pending={{ product: 'redis', attribute: 'redis.version' }}
        retrying={false}
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
