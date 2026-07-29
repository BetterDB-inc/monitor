import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScanSkewAdvisory } from './ScanSkewAdvisory';
import type { ScanSkewReport } from '../../types/metrics';

const report: ScanSkewReport = {
  entriesAnalyzed: 12,
  offenders: [
    {
      key: 'recroom:todo:redo',
      verb: 'SSCAN',
      sightings: 4,
      worstBytesPerElement: 5_000_000,
      totalBytes: 20_000_000,
      lastTimestamp: 1_700_000_100,
      message:
        'SSCAN replies on recroom:todo:redo far exceed the requested COUNT (~4883KB per requested element) — possible degenerate hash chain (valkey#3955). Consider re-creating the key, or upgrade once the upstream fix lands.',
    },
  ],
};

describe('ScanSkewAdvisory', () => {
  it('renders offender rows with key, sightings and the advisory message', () => {
    render(<ScanSkewAdvisory report={report} />);
    expect(screen.getByText('Possible degenerate hash chains')).toBeInTheDocument();
    expect(screen.getByText('recroom:todo:redo')).toBeInTheDocument();
    expect(screen.getAllByText(/valkey#3955/).length).toBeGreaterThan(0);
    expect(screen.getByText(/4 sightings/)).toBeInTheDocument();
    expect(screen.getByText(/Consider re-creating the key/)).toBeInTheDocument();
  });

  it('surfaces backend guidance, including the compact-encoding caveat', () => {
    const withCaveat: ScanSkewReport = {
      entriesAnalyzed: 6,
      offenders: [
        {
          ...report.offenders[0],
          message:
            'SSCAN replies on recroom:todo:redo far exceed the requested COUNT — possible ' +
            'degenerate hash chain (valkey#3955). Consider re-creating the key, or upgrade once ' +
            'the upstream fix lands. If the collection is small enough to use a compact encoding ' +
            '(listpack/intset), a single full-collection reply is expected server behavior and ' +
            'needs no action.',
        },
      ],
    };
    render(<ScanSkewAdvisory report={withCaveat} />);
    expect(screen.getByText(/compact encoding/)).toBeInTheDocument();
    expect(screen.getByText(/needs no action/)).toBeInTheDocument();
  });

  it('renders a singular sighting label for a single-hit offender', () => {
    const singleHit: ScanSkewReport = {
      entriesAnalyzed: 3,
      offenders: [{ ...report.offenders[0], sightings: 1 }],
    };
    render(<ScanSkewAdvisory report={singleHit} />);
    expect(screen.getByText(/1 sighting\b/)).toBeInTheDocument();
    expect(screen.queryByText(/1 sightings/)).not.toBeInTheDocument();
  });

  it('renders nothing when there are no offenders', () => {
    const { container } = render(
      <ScanSkewAdvisory report={{ entriesAnalyzed: 5, offenders: [] }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the report has not loaded', () => {
    const { container } = render(<ScanSkewAdvisory report={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
