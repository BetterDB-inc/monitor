import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BrokerTokenDto } from '../dto/broker-token.dto';

const VALID = {
  email: 'owner@example.com',
  provider: 'google',
  providerId: 'g-1',
  aud: 'http://localhost:3001',
  state: 'A'.repeat(43),
};

async function errorsFor(body: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(plainToInstance(BrokerTokenDto, body));
  return errors.map((error) => {
    return error.property;
  });
}

describe('BrokerTokenDto', () => {
  it('accepts a localhost http origin and optional profile fields', async () => {
    expect(
      await errorsFor({ ...VALID, name: 'Owner', avatarUrl: 'https://a.example/x.png' }),
    ).toEqual([]);
  });

  it('rejects an unknown provider, a malformed state and a non-http aud', async () => {
    expect(await errorsFor({ ...VALID, provider: 'gitlab' })).toEqual(['provider']);
    expect(await errorsFor({ ...VALID, state: 'short' })).toEqual(['state']);
    expect(await errorsFor({ ...VALID, aud: 'ftp://host' })).toEqual(['aud']);
    expect(await errorsFor({ ...VALID, email: 'nope' })).toEqual(['email']);
  });

  it('rejects an http-scheme avatarUrl', async () => {
    expect(await errorsFor({ ...VALID, avatarUrl: 'http://a.example/x.png' })).toEqual([
      'avatarUrl',
    ]);
  });

  it('rejects an empty providerId and a providerId over 200 chars', async () => {
    expect(await errorsFor({ ...VALID, providerId: '' })).toEqual(['providerId']);
    expect(await errorsFor({ ...VALID, providerId: 'a'.repeat(201) })).toEqual(['providerId']);
  });

  it('rejects a name over 200 chars', async () => {
    expect(await errorsFor({ ...VALID, name: 'a'.repeat(201) })).toEqual(['name']);
  });
});
