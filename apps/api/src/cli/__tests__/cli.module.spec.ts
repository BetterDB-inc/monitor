import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { CliGateway } from '../cli.gateway';
import { CliModule } from '../cli.module';

@Global()
@Module({
  providers: [
    { provide: ConnectionRegistry, useValue: {} },
    {
      provide: ConfigService,
      useValue: {
        get: (): undefined => {
          return undefined;
        },
      },
    },
  ],
  exports: [ConnectionRegistry, ConfigService],
})
class StubDependenciesModule {}

describe('CliModule', () => {
  it('resolves the gateway without the workspace auth module', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StubDependenciesModule, CliModule],
    }).compile();
    const gateway = moduleRef.get(CliGateway);
    expect(gateway).toBeInstanceOf(CliGateway);
    await moduleRef.close();
  });
});
