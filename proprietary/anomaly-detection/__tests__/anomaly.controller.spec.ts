import { BadRequestException } from '@nestjs/common';
import { parseIncidentTime } from '../anomaly.controller';

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
