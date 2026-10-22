import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateKvCacheEngineDto, UpdateKvCacheEngineDto } from '../dto/kv-cache-engine.dto';
import { UpdateKvCacheSettingsDto } from '../dto/kv-cache-settings.dto';

async function errorsFor<T extends object>(cls: new () => T, body: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, body));
  return errors.map((error) => error.property);
}

describe('KV cache DTO null handling', () => {
  it('rejects null for optional engine update fields', async () => {
    for (const field of ['name', 'scrapeUrl', 'enabled']) {
      expect(await errorsFor(UpdateKvCacheEngineDto, { [field]: null })).toEqual([field]);
    }
  });

  it('still allows clearing the scrape auth header with null and omitting fields', async () => {
    expect(await errorsFor(UpdateKvCacheEngineDto, { scrapeAuthHeader: null })).toEqual([]);
    expect(await errorsFor(UpdateKvCacheEngineDto, {})).toEqual([]);
  });

  it('rejects null for optional engine create fields', async () => {
    const base = { name: 'e', source: 'otlp' };
    for (const field of ['scrapeAuthHeader', 'otlpEngineId', 'enabled']) {
      expect(await errorsFor(CreateKvCacheEngineDto, { ...base, [field]: null })).toEqual([field]);
    }
    expect(await errorsFor(CreateKvCacheEngineDto, base)).toEqual([]);
  });

  it('rejects null for settings fields', async () => {
    for (const field of ['hitRateAlertEnabled', 'hitRateThreshold', 'evictionAlertEnabled']) {
      expect(await errorsFor(UpdateKvCacheSettingsDto, { [field]: null })).toEqual([field]);
    }
    expect(await errorsFor(UpdateKvCacheSettingsDto, {})).toEqual([]);
  });

  it('rejects credentials in the scrape URL and points at the auth header', async () => {
    const url = 'http://admin:secret@vllm:8000/metrics';
    for (const [cls, body] of [
      [CreateKvCacheEngineDto, { name: 'e', source: 'scrape', scrapeUrl: url }],
      [UpdateKvCacheEngineDto, { scrapeUrl: url }],
      [UpdateKvCacheEngineDto, { scrapeUrl: 'http://token@vllm/metrics' }],
    ] as const) {
      const errors = await validate(plainToInstance(cls as new () => object, body));
      expect(errors.map((error) => error.property)).toEqual(['scrapeUrl']);
      expect(Object.values(errors[0].constraints ?? {}).join(' ')).toContain('scrapeAuthHeader');
    }
    expect(await errorsFor(UpdateKvCacheEngineDto, { scrapeUrl: 'http://vllm:8000/metrics' })).toEqual([]);
  });

  it('accepts scrape hosts with underscores such as compose service names', async () => {
    const scrapeUrl = 'http://vllm_engine:8000/metrics';
    expect(await errorsFor(CreateKvCacheEngineDto, { name: 'e', source: 'scrape', scrapeUrl })).toEqual([]);
    expect(await errorsFor(UpdateKvCacheEngineDto, { scrapeUrl })).toEqual([]);
  });
});
