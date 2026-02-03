import { Global, Module } from '@nestjs/common';
import { VersionCheckService } from './version-check.service';
import { VersionCheckController } from './version-check.controller';

@Global()
@Module({
  providers: [VersionCheckService],
  controllers: [VersionCheckController],
  exports: [VersionCheckService],
})
export class VersionCheckModule {}
