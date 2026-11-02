import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import configuration from './configuration';
import { join } from 'path';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: join(__dirname, '../../../..', '.env'),
      ignoreEnvFile: process.env.JEST_WORKER_ID !== undefined,
    }),
  ],
})
export class ConfigModule {}
