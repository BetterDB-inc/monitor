import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TelemetryModule } from '../telemetry.module';
import { UsageTelemetryService } from '../usage-telemetry.service';
import { TelemetryPort } from '../../common/interfaces/telemetry-port.interface';

describe('Telemetry Integration', () => {
  it('should wire UsageTelemetryService to the TELEMETRY_CLIENT adapter', async () => {
    const mockAdapter: TelemetryPort = {
      capture: jest.fn(),
      identify: jest.fn(),
      shutdown: jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        TelemetryModule,
      ],
    })
      .overrideProvider('TELEMETRY_CLIENT')
      .useValue(mockAdapter)
      .compile();

    const service = module.get(UsageTelemetryService);

    await service.trackPageView('/dashboard');

    expect(mockAdapter.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'page_view',
        properties: expect.objectContaining({ path: '/dashboard' }),
      }),
    );
  });

  it('should call identify on trackAppStart', async () => {
    const mockAdapter: TelemetryPort = {
      capture: jest.fn(),
      identify: jest.fn(),
      shutdown: jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        TelemetryModule,
      ],
    })
      .overrideProvider('TELEMETRY_CLIENT')
      .useValue(mockAdapter)
      .compile();

    const service = module.get(UsageTelemetryService);

    await service.trackAppStart();

    expect(mockAdapter.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'app_start' }),
    );
  });
});
