import {
  computeConnectionChurn,
  isChurnWithFlatPopulation,
  trimPopulationWindow,
  ConnectionChurnReading,
} from '../connection-churn';

const reading = (
  totalReceived: number,
  connectedClients: number,
  timestamp: number,
): ConnectionChurnReading => ({
  totalReceived,
  connectedClients,
  timestamp,
});

describe('computeConnectionChurn', () => {
  it('has no rate on the first poll', () => {
    const sample = computeConnectionChurn(undefined, reading(500, 40, 1_000));

    expect(sample.connectsPerSec).toBeNull();
    expect(sample.clientsDeltaRatio).toBeNull();
    expect(sample.connectedClients).toBe(40);
  });

  it('has no rate after a counter reset', () => {
    const sample = computeConnectionChurn(reading(500, 40, 1_000), reading(20, 40, 2_000));

    expect(sample.connectsPerSec).toBeNull();
  });

  it('has no rate when time did not advance', () => {
    const sample = computeConnectionChurn(reading(500, 40, 1_000), reading(600, 40, 1_000));

    expect(sample.connectsPerSec).toBeNull();
  });

  it('computes connects per second and the population change ratio', () => {
    const sample = computeConnectionChurn(reading(1_000, 50, 0), reading(1_400, 55, 2_000));

    expect(sample.connectsPerSec).toBe(200);
    expect(sample.clientsDeltaRatio).toBeCloseTo(0.1);
  });

  it('measures the population change against a given baseline', () => {
    const sample = computeConnectionChurn(
      reading(1_000, 1_100, 0),
      reading(1_400, 1_150, 1_000),
      1_000,
    );

    expect(sample.clientsDeltaRatio).toBeCloseTo(0.15);
  });

  it('measures the population ratio against at least one client', () => {
    const sample = computeConnectionChurn(reading(0, 0, 0), reading(10, 0, 1_000));

    expect(sample.clientsDeltaRatio).toBe(0);
  });
});

describe('trimPopulationWindow', () => {
  it('keeps readings from the last minute', () => {
    const kept = trimPopulationWindow(
      [reading(0, 10, 0), reading(0, 20, 50_000), reading(0, 30, 70_000)],
      100_000,
    );

    expect(kept.map((r) => r.connectedClients)).toEqual([20, 30]);
  });
});

describe('isChurnWithFlatPopulation', () => {
  it('flags high churn while connected clients stay flat', () => {
    const sample = computeConnectionChurn(reading(0, 100, 0), reading(500, 102, 1_000));

    expect(isChurnWithFlatPopulation(sample)).toBe(true);
  });

  it('ignores churn that comes with a population jump', () => {
    const sample = computeConnectionChurn(reading(0, 100, 0), reading(500, 160, 1_000));

    expect(isChurnWithFlatPopulation(sample)).toBe(false);
  });

  it('ignores a low connect rate', () => {
    const sample = computeConnectionChurn(reading(0, 100, 0), reading(5, 100, 1_000));

    expect(isChurnWithFlatPopulation(sample)).toBe(false);
  });

  it('ignores a sample without a rate', () => {
    expect(isChurnWithFlatPopulation(computeConnectionChurn(undefined, reading(5, 100, 0)))).toBe(
      false,
    );
  });
});
