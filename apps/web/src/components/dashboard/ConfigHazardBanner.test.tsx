import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConfigHazardBanner } from './ConfigHazardBanner';
import type { ConfigHazardFinding } from '../../types/health';

const hazard: ConfigHazardFinding = {
  id: 'default-user-aof-data-loss',
  severity: 'warning',
  status: 'hazard',
  message:
    'The default user is disabled with AOF enabled — EXEC/function writes can be silently lost on AOF reload (valkey#3983). Grant `default +@all ~* &*`, or keep the user enabled.',
};

const unverified: ConfigHazardFinding = {
  ...hazard,
  status: 'unverified',
  message:
    'AOF is enabled but the default user ACL could not be verified (ACL GETUSER denied) — (valkey#3983).',
};

describe('ConfigHazardBanner', () => {
  it('renders the hazard message with the remediation grant', () => {
    render(<ConfigHazardBanner hazards={[hazard]} />);
    expect(screen.getByText('Hazardous server configuration')).toBeInTheDocument();
    expect(screen.getByText(/valkey#3983/)).toBeInTheDocument();
    expect(screen.getByText(/\+@all ~\* &\*/)).toBeInTheDocument();
  });

  it('renders nothing when there are no hazards', () => {
    const { container } = render(<ConfigHazardBanner hazards={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when hazards is undefined', () => {
    const { container } = render(<ConfigHazardBanner hazards={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('presents an unverified finding as a verification notice, not a confirmed hazard', () => {
    render(<ConfigHazardBanner hazards={[unverified]} />);
    expect(screen.getByText('Configuration could not be verified')).toBeInTheDocument();
    expect(screen.queryByText('Hazardous server configuration')).not.toBeInTheDocument();
  });

  it('presents an advisory finding as a low-key advisory, not a confirmed hazard', () => {
    const advisory: ConfigHazardFinding = {
      id: 'appendfsync-always-blocking',
      severity: 'info',
      status: 'advisory',
      message:
        'appendfsync=always fsyncs on the main thread for every write — a known latency risk (valkey#3515).',
    };
    render(<ConfigHazardBanner hazards={[advisory]} />);
    expect(screen.getByText('Configuration advisory')).toBeInTheDocument();
    expect(screen.getByText(/valkey#3515/)).toBeInTheDocument();
    expect(screen.queryByText('Hazardous server configuration')).not.toBeInTheDocument();
  });

  it('renders an escalated appendfsync hazard as a confirmed hazard', () => {
    const escalated: ConfigHazardFinding = {
      id: 'appendfsync-always-blocking',
      severity: 'warning',
      status: 'hazard',
      message:
        'appendfsync=always is blocking the main thread on this instance: aof_delayed_fsync is rising (now 42).',
    };
    render(<ConfigHazardBanner hazards={[escalated]} />);
    expect(screen.getByText('Hazardous server configuration')).toBeInTheDocument();
  });
});
