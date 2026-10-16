import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { WebhookDispatcherService } from '../webhook-dispatcher.service';
import { WebhooksService } from '../webhooks.service';

describe('WebhookDispatcherService WEBHOOK_ALERT_STATE_MAX', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function build(alertStateMax: unknown): Promise<WebhookDispatcherService> {
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'WEBHOOK_ALERT_STATE_MAX') return alertStateMax;
        if (key === 'database.host') return 'localhost';
        if (key === 'database.port') return 6379;
        return undefined;
      }),
    } as unknown as ConfigService;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDispatcherService,
        { provide: WebhooksService, useValue: {} },
        { provide: 'STORAGE_CLIENT', useValue: {} },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    return module.get(WebhookDispatcherService);
  }

  const maxOf = (dispatcher: WebhookDispatcherService): number =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dispatcher as any).alertStates.max;

  it('parses a string env value (raw ConfigService output)', async () => {
    expect(maxOf(await build('50000'))).toBe(50000);
  });

  it('uses the default when unset', async () => {
    expect(maxOf(await build(undefined))).toBe(10000);
  });

  it.each(['abc', '0', '-5', '1.5'])('falls back to the default for invalid %p', async (raw) => {
    expect(maxOf(await build(raw))).toBe(10000);
  });
});
