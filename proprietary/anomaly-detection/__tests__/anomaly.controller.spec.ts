import { BadRequestException } from '@nestjs/common';
import { AnomalyController, parseIncidentTime } from '../anomaly.controller';
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
  };
  const controller = new AnomalyController(service as unknown as AnomalyService);

  const routes: Array<[string, (start?: string, end?: string) => Promise<unknown>]> = [
    ['events', async (s, e) => controller.getEvents(undefined, undefined, undefined, s, e)],
    ['groups', async (s, e) => controller.getGroups(undefined, undefined, undefined, s, e)],
    ['summary', async (s, e) => controller.getSummary(undefined, s, e)],
    ['replication-divergence', async (s, e) => controller.getReplicationDivergence('c1', s, e)],
  ];

  beforeEach(() => jest.clearAllMocks());

  describe.each(routes)('%s', (_name, call) => {
    it.each([
      ['a non-numeric start', 'abc', undefined],
      ['a non-numeric end', undefined, 'abc'],
      ['trailing junk', '12abc', undefined],
      ['a negative start', '-1', undefined],
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
  });

  it('honours an explicit start of 0 on the events route', async () => {
    await controller.getEvents(undefined, undefined, undefined, '0', '1000');

    expect(service.getRecentAnomalies.mock.calls[0].slice(0, 2)).toEqual([0, 1000]);
  });

});

describe('parseIncidentTime', () => {
  it('passes through a missing value', () => {
    expect(parseIncidentTime('startTime', undefined)).toBeUndefined();
  });

  it('parses an epoch time', () => {
    expect(parseIncidentTime('startTime', '1700000000000')).toBe(1_700_000_000_000);
  });

  it.each(['', 'abc', '12abc', 'NaN', 'Infinity', '0', '-1', '1.5', '99999999999999999999'])(
    'rejects %j',
    (value) => {
      expect(() => parseIncidentTime('startTime', value)).toThrow(BadRequestException);
    },
  );
});
