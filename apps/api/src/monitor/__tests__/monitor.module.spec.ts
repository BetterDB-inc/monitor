import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LicenseGuard } from '@proprietary/licenses';
import { MonitorModule } from '../monitor.module';
import { TailGateway } from '../tail.gateway';

describe('MonitorModule', () => {
  const previousStorageType = process.env.STORAGE_TYPE;

  beforeAll(() => {
    process.env.STORAGE_TYPE = 'memory';
  });

  afterAll(() => {
    if (previousStorageType === undefined) {
      delete process.env.STORAGE_TYPE;
      return;
    }
    process.env.STORAGE_TYPE = previousStorageType;
  });

  it('resolves the tail gateway without the workspace auth module', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), MonitorModule],
    })
      .overrideGuard(LicenseGuard)
      .useValue({
        canActivate: (): boolean => {
          return true;
        },
      })
      .compile();
    const gateway = moduleRef.get(TailGateway);
    expect(gateway).toBeInstanceOf(TailGateway);
    await moduleRef.close();
  });
});
