import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KvCacheAdvisories } from '../KvCacheAdvisories';

describe('KvCacheAdvisories', () => {
  it('renders the unevictable title and the TTL hint', () => {
    render(
      <KvCacheAdvisories
        advisories={[
          {
            kind: 'unevictable',
            title: 'LMCache keys can never be evicted',
            body: 'Set valkey_enable_ttl on the valkey:// connector.',
          },
        ]}
      />,
    );
    expect(screen.getByText('LMCache keys can never be evicted')).toBeInTheDocument();
    expect(screen.getByText(/valkey_enable_ttl/)).toBeInTheDocument();
  });

  it('renders nothing when there are no advisories', () => {
    const { container } = render(<KvCacheAdvisories advisories={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
