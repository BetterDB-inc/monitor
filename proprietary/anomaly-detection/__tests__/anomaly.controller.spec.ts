import { BadRequestException } from '@nestjs/common';
import { AnomalyController } from '../anomaly.controller';
import { AnomalyService } from '../anomaly.service';

jest.mock('@proprietary/licenses', () => ({
  LicenseGuard: class {},
  RequiresFeature: () => () => undefined,
  Feature: { ANOMALY_DETECTION: 'anomaly-detection' },
}));

describe('AnomalyController time bounds', () => {
  const service = {
    getRecentAnomalies: jest.fn().mockResolvedValue([]),
    getRecentCorrelatedGroups: jest.fn().mockResolvedValue([]),
    getSummary: jest.fn().mockResolvedValue({}),
    getReplicationDivergenceHistory: jest.fn().mockResolvedValue([]),
    getIncidentTimelines: jest.fn().mockResolvedValue([]),
    getIncidentTimeline: jest.fn().mockResolvedValue({}),
  };
  const controller = new AnomalyController(service as unknown as AnomalyService);

  const routes: Array<[string, (start?: string, end?: string) => Promise<unknown>]> = [
    ['events', async (s, e) => controller.getEvents(undefined, undefined, undefined, s, e)],
    ['groups', async (s, e) => controller.getGroups(undefined, undefined, undefined, s, e)],
    ['summary', async (s, e) => controller.getSummary(undefined, s, e)],
    ['replication-divergence', async (s, e) => controller.getReplicationDivergence('c1', s, e)],
    ['incidents', async (s, e) => controller.getIncidents(undefined, undefined, s, e)],
  ];

  beforeEach(() => jest.clearAllMocks());

  describe.each(routes)('%s', (_name, call) => {
    it.each([
      ['a non-numeric start', 'abc', undefined],
      ['a non-numeric end', undefined, 'abc'],
      ['a whitespace start', '   ', undefined],
      ['a whitespace end', undefined, '   '],
      ['an inverted range', '2000', '1000'],
    ])('rejects %s', async (_case, start, end) => {
      await expect(call(start, end)).rejects.toBeInstanceOf(BadRequestException);
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    });

    it('accepts equal bounds', async () => {
      await expect(call('1000', '1000')).resolves.toBeDefined();
    });

    it('accepts missing bounds', async () => {
      await expect(call()).resolves.toBeDefined();
    });

    it('accepts fractional timestamps', async () => {
      await expect(call('1000.5', '2000.9')).resolves.toBeDefined();
    });
  });

  it('truncates fractional timestamps', async () => {
    await controller.getEvents(undefined, undefined, undefined, '1000.5', '2000.9');

    expect(service.getRecentAnomalies.mock.calls[0].slice(0, 2)).toEqual([1000, 2000]);
  });

  it('truncates a fractional start on the single incident route', async () => {
    await controller.getIncident('incident-1', 'c1', '1000.5');

    expect(service.getIncidentTimeline).toHaveBeenCalledWith('incident-1', 'c1', 1000);
  });

  it('honours an explicit start of 0 on the events route', async () => {
    await controller.getEvents(undefined, undefined, undefined, '0', '1000');

    expect(service.getRecentAnomalies.mock.calls[0].slice(0, 2)).toEqual([0, 1000]);
  });

});

describe('AnomalyController incident limit', () => {
  const service = { getIncidentTimelines: jest.fn().mockResolvedValue([]) };
  const controller = new AnomalyController(service as unknown as AnomalyService);

  beforeEach(() => jest.clearAllMocks());

  it.each(['abc', '-1', '0', '1.5', '10abc', '   '])('rejects %j', async (limit) => {
    await expect(controller.getIncidents(undefined, limit)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.getIncidentTimelines).not.toHaveBeenCalled();
  });

  it('caps the limit at 1000', async () => {
    await controller.getIncidents('c1', '999999');
    await controller.getIncidents('c1', '1000');

    expect(service.getIncidentTimelines.mock.calls.map((c) => c[3])).toEqual([1000, 1000]);
  });

  it('passes a valid limit and defaults to 50', async () => {
    await controller.getIncidents('c1', '10');
    await controller.getIncidents('c1');

    expect(service.getIncidentTimelines.mock.calls.map((c) => c[3])).toEqual([10, 50]);
  });
});

describe('AnomalyController fan-out coverage', () => {
  const coverage = {
    connectionId: 'c1',
    checked: 2,
    unreachable: 1,
    skipped: 0,
    reason: null,
    timestamp: 1_000,
  };
  const service = { getFanoutCoverage: jest.fn().mockReturnValue([coverage]) };
  const controller = new AnomalyController(service as unknown as AnomalyService);

  beforeEach(() => jest.clearAllMocks());

  it('returns the coverage of the connection in the header', () => {
    expect(controller.getCoverage('c1')).toEqual([coverage]);
    expect(service.getFanoutCoverage).toHaveBeenCalledWith('c1');
  });

  it('returns every connection without the header', () => {
    controller.getCoverage(undefined);

    expect(service.getFanoutCoverage).toHaveBeenCalledWith(undefined);
  });
});
