import { ConfigModule } from '@nestjs/config';

export function ignoreEnvFile(): void {
  const forRoot = ConfigModule.forRoot.bind(ConfigModule);
  ConfigModule.forRoot = ((options = {}) =>
    forRoot({ ...options, ignoreEnvFile: true })) as typeof ConfigModule.forRoot;
}
