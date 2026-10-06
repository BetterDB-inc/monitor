import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../api/client', () => ({ fetchApi: vi.fn(), apiOrigin: () => 'http://localhost:3001' }));

import { OtlpPushTab } from './OtlpPushTab';

describe('OtlpPushTab prefill', () => {
  it('starts from the initial values', () => {
    render(
      <OtlpPushTab isFirstConnection={false} onCreated={vi.fn()} onDone={vi.fn()} initialName="orders-cache" initialHost="cache.internal" initialPort={6380} />,
    );
    expect(screen.getByDisplayValue('orders-cache')).toBeInTheDocument();
    expect(screen.getByDisplayValue('cache.internal')).toBeInTheDocument();
    expect(screen.getByDisplayValue('6380')).toBeInTheDocument();
  });
});
