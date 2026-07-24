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
    expect(screen.getByText(/valkey#3955/)).toBeInTheDocument();
    expect(screen.getByText(/4 sightings/)).toBeInTheDocument();
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
