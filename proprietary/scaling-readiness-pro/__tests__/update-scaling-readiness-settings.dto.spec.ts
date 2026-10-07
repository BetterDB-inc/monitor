import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateScalingReadinessSettingsDto } from '../dto/update-scaling-readiness-settings.dto';

async function errorsFor(body: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(plainToInstance(UpdateScalingReadinessSettingsDto, body));
  return errors.map((error) => error.property);
}

describe('UpdateScalingReadinessSettingsDto', () => {
  it('accepts thresholds from 1 to 80', async () => {
    expect(await errorsFor({ alertThreshold: 1 })).toEqual([]);
    expect(await errorsFor({ alertThreshold: 80 })).toEqual([]);
  });

  it('rejects thresholds the alert could never re-arm from', async () => {
    expect(await errorsFor({ alertThreshold: 81 })).toEqual(['alertThreshold']);
    expect(await errorsFor({ alertThreshold: 0 })).toEqual(['alertThreshold']);
  });
});
