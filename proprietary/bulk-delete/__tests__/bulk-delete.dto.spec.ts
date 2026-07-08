import { ValidationPipe } from '@nestjs/common';
import { BulkDeleteExecuteDto, BulkDeletePreviewDto } from '../dto/bulk-delete.dto';

// Mirror the global pipe from main.ts so we exercise forbidNonWhitelisted.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const body = { match: 'session:*', scope: 'node', count: 200, batchPauseMs: 100 };

describe('bulk-delete DTO validation', () => {
  it('accepts batchPauseMs on the preview body (same shape as execute)', async () => {
    // Regression: preview used to reject batchPauseMs under forbidNonWhitelisted.
    await expect(
      pipe.transform(body, { type: 'body', metatype: BulkDeletePreviewDto }),
    ).resolves.toMatchObject({ match: 'session:*', batchPauseMs: 100 });
  });

  it('accepts the same body on the execute DTO', async () => {
    await expect(
      pipe.transform(body, { type: 'body', metatype: BulkDeleteExecuteDto }),
    ).resolves.toMatchObject({ batchPauseMs: 100 });
  });

  it('rejects a truly unknown property', async () => {
    await expect(
      pipe.transform({ match: 'a:*', bogus: 1 }, { type: 'body', metatype: BulkDeletePreviewDto }),
    ).rejects.toThrow();
  });

  it('rejects a missing match pattern', async () => {
    await expect(
      pipe.transform({ scope: 'node' }, { type: 'body', metatype: BulkDeletePreviewDto }),
    ).rejects.toThrow();
  });
});
