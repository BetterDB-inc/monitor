import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TelemetryModule } from '../telemetry.module';
import { UsageTelemetryService } from '../usage-telemetry.service';
import { TelemetryPort } from '../../common/interfaces/telemetry-port.interface';

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
  let service: UsageTelemetryService;

  beforeEach(async () => {
    mockAdapter = createMockAdapter();
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        TelemetryModule,
      ],
    })
      .overrideProvider('TELEMETRY_CLIENT')
      .useValue(mockAdapter)
      .compile();

    service = module.get(UsageTelemetryService);
  });

  it('should delegate trackPageView to the TELEMETRY_CLIENT adapter', async () => {
    await service.trackPageView('/dashboard');

    expect(mockAdapter.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'page_view',
        properties: expect.objectContaining({ path: '/dashboard' }),
      }),
    );
  });

  it('should delegate trackAppStart to the TELEMETRY_CLIENT adapter', async () => {
    await service.trackAppStart();

    expect(mockAdapter.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'app_start' }),
    );
  });
});
