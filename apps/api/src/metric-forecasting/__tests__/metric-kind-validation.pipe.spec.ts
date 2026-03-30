import { BadRequestException } from '@nestjs/common';
import { MetricKindValidationPipe } from '../pipes/metric-kind-validation.pipe';

describe('MetricKindValidationPipe', () => {
  const pipe = new MetricKindValidationPipe();

  it.each(['opsPerSec', 'usedMemory', 'cpuTotal', 'memFragmentation'] as const)(
    'accepts valid metric kind: %s',
    (kind) => {
      expect(pipe.transform(kind)).toBe(kind);
    },
  );

  it('throws BadRequestException for invalid metric kind', () => {
    expect(() => pipe.transform('invalid')).toThrow(BadRequestException);
  });

  it('includes valid kinds in error message', () => {
    try {
      pipe.transform('bogus');
    } catch (e) {
      expect((e as BadRequestException).message).toContain('opsPerSec');
      expect((e as BadRequestException).message).toContain('usedMemory');
    }
  });
});
