import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConnectionCard } from './ConnectionCard';
import type { Connection } from '../../hooks/useConnection';
import type { HealthResponse } from '../../types/metrics';

const health = {
  status: 'connected',
  database: { type: 'valkey', version: '8.1.0', host: 'host.docker.internal', port: 6422 },
} as unknown as HealthResponse;

function connection(over: Partial<Connection>): Connection {
  return { id: 'c', name: 'c', host: 'h', port: 1, isConnected: true, ...over } as Connection;
}

describe('ConnectionCard', () => {
  it('marks an OTLP-pushed connection', () => {
    render(
      <ConnectionCard
        health={health}
        loading={false}
        connection={connection({ connectionType: 'external' })}
      />,
    );

    expect(screen.getByText('OTLP')).toBeInTheDocument();
  });

  it('does not mark a direct connection', () => {
    render(<ConnectionCard health={health} loading={false} connection={connection({})} />);

    expect(screen.queryByText('OTLP')).toBeNull();
  });
});
