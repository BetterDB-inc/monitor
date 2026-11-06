import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { AnomalyController, IncidentLookupDto } from '../anomaly.controller';
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

describe('AnomalyController incident lookup', () => {
  const service = { findIncidentIdForAnomalies: jest.fn() };
  const controller = new AnomalyController(service as unknown as AnomalyService);
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const validate = (body: unknown) =>
    pipe.transform(body, { type: 'body', metatype: IncidentLookupDto });

  beforeEach(() => jest.clearAllMocks());

  it('looks up the incident holding the anomalies', async () => {
    service.findIncidentIdForAnomalies.mockResolvedValue('100-abc');
    const body = await validate({ anomalyIds: ['a', 'b'], startTime: 1000, endTime: 2000 });

    await expect(controller.lookupIncident(body, 'c1')).resolves.toEqual({
      incidentId: '100-abc',
    });
    expect(service.findIncidentIdForAnomalies).toHaveBeenCalledWith(['a', 'b'], 1000, 2000, 'c1');
  });

  it('accepts the full 500 ids in the body', async () => {
    const anomalyIds = Array.from({ length: 500 }, (_, i) => `a${i}`);
    await expect(validate({ anomalyIds, startTime: 1000, endTime: 2000 })).resolves.toMatchObject({
      anomalyIds,
    });
  });

  it('returns 404 when no incident holds them', async () => {
    service.findIncidentIdForAnomalies.mockResolvedValue(null);

    await expect(
      controller.lookupIncident({ anomalyIds: ['a'], startTime: 1000, endTime: 2000 }, 'c1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a start after the end', async () => {
    await expect(
      controller.lookupIncident({ anomalyIds: ['a'], startTime: 2000, endTime: 1000 }, 'c1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.findIncidentIdForAnomalies).not.toHaveBeenCalled();
  });

  it.each([
    ['no ids', { startTime: 1000, endTime: 2000 }],
    ['an empty id list', { anomalyIds: [], startTime: 1000, endTime: 2000 }],
    [
      'too many ids',
      { anomalyIds: Array.from({ length: 501 }, (_, i) => `a${i}`), startTime: 1000, endTime: 2000 },
    ],
    ['a non-string id', { anomalyIds: [1], startTime: 1000, endTime: 2000 }],
    ['no start', { anomalyIds: ['a'], endTime: 2000 }],
    ['no end', { anomalyIds: ['a'], startTime: 1000 }],
  ])('rejects %s', async (_case, body) => {
    await expect(validate(body)).rejects.toBeInstanceOf(BadRequestException);
  });
});
