import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { CreateValkeyInstanceDto } from '../dto/create-valkey-instance.dto';

async function validationErrors(maxmemory?: string) {
  const dto = new CreateValkeyInstanceDto();
  dto.tenantId = 'tenant-1';
  dto.name = 'my-instance';
  if (maxmemory !== undefined) dto.maxmemory = maxmemory;
  const errors = await validate(dto);
  return errors.filter((e) => e.property === 'maxmemory');
}

describe('CreateValkeyInstanceDto maxmemory cap', () => {
  it('accepts the offered sizes', async () => {
    for (const size of ['256mb', '768mb', '1gb', '2gb', '2048mb']) {
      expect(await validationErrors(size)).toHaveLength(0);
    }
  });

  it('accepts a missing maxmemory', async () => {
    expect(await validationErrors()).toHaveLength(0);
  });

  it('rejects sizes above 2gb', async () => {
    for (const size of ['3gb', '2049mb', '100gb', '999999999gb']) {
      const errors = await validationErrors(size);
      expect(errors.length).toBeGreaterThan(0);
      expect(JSON.stringify(errors[0].constraints)).toContain('cannot exceed 2gb');
    }
  });

  it('still rejects malformed values via the format rule', async () => {
    for (const size of ['1tb', 'abc', '1 gb']) {
      expect((await validationErrors(size)).length).toBeGreaterThan(0);
    }
  });
});
