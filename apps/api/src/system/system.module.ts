import { Module } from '@nestjs/common';
import { SystemController } from './system.controller';

@Module({
  controllers: [SystemController],
})
export class SystemModule {}
