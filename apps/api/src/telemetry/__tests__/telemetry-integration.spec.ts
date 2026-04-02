import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TelemetryModule } from '../telemetry.module';
import { UsageTelemetryService } from '../usage-telemetry.service';
import { TelemetryPort } from '../../common/interfaces/telemetry-port.interface';
import { ConfigService } from '@nestjs/config';

function createMockAdapter(): TelemetryPort & {
  capture: jest.Mock;
  identify: jest.Mock;
  shutdown: jest.Mock;
} {
  return {
    capture: jest.fn(),
    identify: jest.fn(),
    shutdown: jest.fn().mockResolvedValue(undefined),
  };
}

describe('Telemetry Integration', () => {
  let mockAdapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    mockAdapter = createMockAdapter();
  });

  it('should not capture events when instanceId is not set (no licenseService)', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        await ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        TelemetryModule,
      ],
    })
      .overrideProvider('TELEMETRY_CLIENT')
      .useValue(mockAdapter)
      .compile();

    const service = module.get(UsageTelemetryService);

    await service.trackPageView('/dashboard');
    await service.trackAppStart();

    expect(mockAdapter.capture).not.toHaveBeenCalled();
  });

  it('should delegate events to adapter when instanceId is set', async () => {
    const mockLicenseService = {
      validationPromise: Promise.resolve(),
      getInstanceId: jest.fn().mockReturnValue('test-instance-id'),
      getLicenseTier: jest.fn().mockReturnValue('community'),
      isTelemetryEnabled: true,
    };

    const module: TestingModule = await Test.createTestingModule({
      imports: [await ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      providers: [
        { provide: 'TELEMETRY_CLIENT', useValue: mockAdapter },
        {
          provide: UsageTelemetryService,
          useFactory: (configService: ConfigService) =>
            new UsageTelemetryService(mockAdapter, configService, mockLicenseService as never),
          inject: [ConfigService],
        },
      ],
    }).compile();

    await module.init();

    const service = module.get(UsageTelemetryService);

    expect(mockAdapter.identify).toHaveBeenCalledWith(
      'test-instance-id',
      expect.objectContaining({ tier: 'community' }),
    );
    expect(mockAdapter.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'app_start', distinctId: 'test-instance-id' }),
    );

    mockAdapter.capture.mockClear();
    await service.trackPageView('/dashboard');

    expect(mockAdapter.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'page_view',
        distinctId: 'test-instance-id',
        properties: expect.objectContaining({ path: '/dashboard' }),
      }),
    );

    await module.close();
  });
});
